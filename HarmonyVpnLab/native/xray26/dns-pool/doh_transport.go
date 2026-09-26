package dns

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"

	"golang.org/x/net/http2"
)

var errDoHTransportClosed = errors.New("DoH transport is closed")

// Cancellation belongs to one request/dial, never to the shared HTTP2 pool.
// Keep the parent's values, including the dispatcher instance and routing tag.
func withDoHCancellation(parent, owner context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(owner, cancel)
	if owner.Err() != nil {
		cancel()
	}
	return ctx, func() { stop(); cancel() }
}

// A pool is owned by exactly one DNS feature (and therefore one core instance).
// Only ordinary remote HTTPS with equal full URL and effective inbound tag can
// share. Current DoH TLS policy is fixed verified uTLS/Chrome; local/h2c do not
// share. Any future configurable TLS policy must extend this equivalence key.
type dohPoolKey struct{ url, tag string }
type dohScopeKey struct{}
type dohTransportScope struct {
	mu     sync.Mutex
	closed bool
	pools  map[dohPoolKey]*dohTransport
	owned  map[*dohTransport]struct{}
}

func newDoHTransportScope() *dohTransportScope {
	return &dohTransportScope{pools: make(map[dohPoolKey]*dohTransport), owned: make(map[*dohTransport]struct{})}
}

func (s *dohTransportScope) adopt(server *DoHNameServer, tag string) {
	created := server.transport
	chosen := created
	s.mu.Lock()
	closed := s.closed
	if !closed {
		if server.shareRemoteHTTPS {
			key := dohPoolKey{server.dohURL, tag}
			if existing := s.pools[key]; existing != nil {
				chosen = existing
			} else {
				s.pools[key] = created
			}
		}
		s.owned[chosen] = struct{}{}
	}
	s.mu.Unlock()
	// No connection has been opened by this newly constructed server. Never
	// close under the scope lock: net.Conn.Close can call arbitrary code.
	if closed || chosen != created {
		created.Close()
	}
	server.transport = chosen
	server.httpClient.Transport = chosen
}

func (s *dohTransportScope) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	owners := make([]*dohTransport, 0, len(s.owned))
	for owner := range s.owned {
		owners = append(owners, owner)
	}
	s.pools = nil
	s.owned = nil
	s.mu.Unlock()
	var failures []error
	for _, owner := range owners {
		if err := owner.Close(); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

type dohTransport struct {
	h2     *http2.Transport
	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
	closed bool
	conns  map[*dohTrackedConn]struct{}
}

func newDoHTransport() *dohTransport {
	ctx, cancel := context.WithCancel(context.Background())
	return &dohTransport{h2: &http2.Transport{}, ctx: ctx, cancel: cancel, conns: make(map[*dohTrackedConn]struct{})}
}

// Register raw connections before TLS handshake. Close also interrupts an
// active handshake and shuts a late successful dispatch instead of leaking it.
func (t *dohTransport) track(conn net.Conn) (net.Conn, error) {
	return t.trackWithCancel(conn, nil)
}

func (t *dohTransport) trackWithCancel(conn net.Conn, cancel context.CancelFunc) (net.Conn, error) {
	owned := &dohTrackedConn{Conn: conn, owner: t, cancel: cancel}
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		owned.Close()
		return nil, errDoHTransportClosed
	}
	t.conns[owned] = struct{}{}
	t.mu.Unlock()
	return owned, nil
}

func (t *dohTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.mu.Lock()
	closed := t.closed
	t.mu.Unlock()
	if closed {
		return nil, errDoHTransportClosed
	}
	ctx, cancel := withDoHCancellation(req.Context(), t.ctx)
	response, err := t.h2.RoundTrip(req.WithContext(ctx))
	if err != nil {
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		cancel()
		return nil, err
	}
	// Cancel only after body consumption/Close, not after response headers.
	response.Body = &dohResponseBody{ReadCloser: response.Body, cancel: cancel}
	return response, nil
}

func (t *dohTransport) Close() error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil
	}
	t.closed = true
	conns := make([]*dohTrackedConn, 0, len(t.conns))
	for conn := range t.conns {
		conns = append(conns, conn)
	}
	t.mu.Unlock()
	t.cancel()
	var failures []error
	for _, conn := range conns {
		if err := conn.Close(); err != nil {
			failures = append(failures, err)
		}
	}
	t.h2.CloseIdleConnections()
	return errors.Join(failures...)
}

type dohTrackedConn struct {
	net.Conn
	owner  *dohTransport
	once   sync.Once
	err    error
	cancel context.CancelFunc
}

func (c *dohTrackedConn) Close() error {
	c.once.Do(func() {
		if c.cancel != nil {
			c.cancel()
		}
		c.err = c.Conn.Close()
		c.owner.mu.Lock()
		delete(c.owner.conns, c)
		c.owner.mu.Unlock()
	})
	return c.err
}

type dohResponseBody struct {
	io.ReadCloser
	once   sync.Once
	cancel context.CancelFunc
}

func (b *dohResponseBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err != nil {
		b.once.Do(b.cancel)
	}
	return n, err
}

func (b *dohResponseBody) Close() error {
	err := b.ReadCloser.Close()
	b.once.Do(b.cancel)
	return err
}
