import { ConnectionSnapshot } from './ConnectionSnapshot';

// The service normally publishes a new sample every two seconds. A UI poll can
// read that same sample more than once; its timestamp, not the poll interval,
// determines the rate. Older samples must not keep looking like live traffic.
const MAX_SAMPLE_AGE_MS: number = 6000;
const MIN_SAMPLE_INTERVAL_MS: number = 500;

export class TransferRateReading {
  available: boolean;
  uplinkPerSecond: number;
  downlinkPerSecond: number;

  constructor(available: boolean = false, uplinkPerSecond: number = 0, downlinkPerSecond: number = 0) {
    this.available = available;
    this.uplinkPerSecond = uplinkPerSecond;
    this.downlinkPerSecond = downlinkPerSecond;
  }
}

class TransferRateSample {
  runId: string;
  reconnectCount: number;
  startedAt: number;
  sampledAt: number;
  uplink: number;
  downlink: number;

  constructor(runId: string, reconnectCount: number, snapshot: ConnectionSnapshot) {
    this.runId = runId;
    this.reconnectCount = reconnectCount;
    this.startedAt = snapshot.startedAt;
    this.sampledAt = snapshot.sampledAt;
    this.uplink = snapshot.uplink;
    this.downlink = snapshot.downlink;
  }
}

export class TransferRateTracker {
  private previous?: TransferRateSample;
  private reading: TransferRateReading = new TransferRateReading();
  private needsBaseline: boolean = false;
  private observedAt: number = 0;

  reset(): void {
    this.previous = undefined;
    this.reading = new TransferRateReading();
    this.needsBaseline = false;
    this.observedAt = 0;
  }

  private copyReading(): TransferRateReading {
    return new TransferRateReading(this.reading.available, this.reading.uplinkPerSecond, this.reading.downlinkPerSecond);
  }

  private baseline(sample: TransferRateSample): TransferRateReading {
    this.previous = sample;
    this.reading = new TransferRateReading();
    this.needsBaseline = false;
    return this.copyReading();
  }

  // Call reset when the page hides or either connection state is not active.
  // This object is deliberately memory-only: a saved result is never live rate.
  update(runId: string, reconnectCount: number, snapshot: ConnectionSnapshot | undefined, now: number): TransferRateReading {
    if (!snapshot || snapshot.active !== true || typeof runId !== 'string' || runId.length === 0 ||
      !Number.isSafeInteger(reconnectCount) || reconnectCount < 0 || !Number.isSafeInteger(now) || now <= 0 ||
      !Number.isSafeInteger(snapshot.startedAt) || snapshot.startedAt <= 0 ||
      !Number.isSafeInteger(snapshot.sampledAt) || snapshot.sampledAt < snapshot.startedAt ||
      !Number.isSafeInteger(snapshot.uplink) || snapshot.uplink < 0 ||
      !Number.isSafeInteger(snapshot.downlink) || snapshot.downlink < 0 ||
      snapshot.sampledAt > now || now - snapshot.sampledAt > MAX_SAMPLE_AGE_MS) {
      this.reset();
      return this.copyReading();
    }

    const sample = new TransferRateSample(runId, reconnectCount, snapshot);
    const previous = this.previous;
    const observationInterrupted = this.observedAt > 0 && (now < this.observedAt || now - this.observedAt > MAX_SAMPLE_AGE_MS);
    this.observedAt = now;
    if (!previous || observationInterrupted || previous.runId !== runId || previous.startedAt !== snapshot.startedAt ||
      previous.reconnectCount !== reconnectCount) {
      return this.baseline(sample);
    }

    const elapsed = sample.sampledAt - previous.sampledAt;
    if (elapsed < 0 || (elapsed === 0 && (sample.uplink !== previous.uplink || sample.downlink !== previous.downlink))) {
      // Keep the last accepted timestamp. Repeated reads of an older or
      // internally inconsistent snapshot must not become a new baseline.
      this.reading = new TransferRateReading();
      this.needsBaseline = true;
      return this.copyReading();
    }
    if (elapsed === 0) { return this.copyReading(); }
    if (this.needsBaseline || elapsed < MIN_SAMPLE_INTERVAL_MS || elapsed > MAX_SAMPLE_AGE_MS ||
      sample.uplink < previous.uplink || sample.downlink < previous.downlink) {
      return this.baseline(sample);
    }

    this.reading = new TransferRateReading(true,
      (sample.uplink - previous.uplink) * 1000 / elapsed,
      (sample.downlink - previous.downlink) * 1000 / elapsed);
    this.previous = sample;
    return this.copyReading();
  }
}

export function formatTransferRate(available: boolean, value: number): string {
  if (!available || !Number.isFinite(value) || value < 0) { return '—'; }
  const units: string[] = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s', 'PB/s'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
