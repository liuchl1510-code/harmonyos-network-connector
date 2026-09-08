#pragma once
#include <string>

// Bounded, local-only socket controls. Returns flags/counts, never addresses.
std::string RunPollEdgeControls();
