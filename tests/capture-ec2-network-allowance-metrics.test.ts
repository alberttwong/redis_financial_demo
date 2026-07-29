import assert from "node:assert/strict";
import test from "node:test";
import {
  NETWORK_ALLOWANCE_METRICS,
  renderNetworkAllowanceMarkdown,
  summarizeNetworkAllowanceMetrics,
  type CounterSeries
} from "../scripts/capture-ec2-network-allowance-metrics";

const startedAt = "2026-07-28T00:01:00.000Z";
const endedAt = "2026-07-28T00:03:00.000Z";
const timestamps = [
  "2026-07-28T00:00:00.000Z",
  "2026-07-28T00:02:00.000Z",
  "2026-07-28T00:04:00.000Z"
];

test("network allowance summary calculates cumulative counter deltas and resets", () => {
  const instanceId = "i-api000000000001";
  const series = [
    metricSeries(instanceId, "bandwidth_in_allowance_exceeded", [100, 104, 109]),
    metricSeries(instanceId, "bandwidth_out_allowance_exceeded", [20, 20, 20]),
    metricSeries(instanceId, "pps_allowance_exceeded", [10, 13, 2]),
    metricSeries(instanceId, "conntrack_allowance_exceeded", [0, 0, 0]),
    metricSeries(instanceId, "linklocal_allowance_exceeded", [7, 7, 7])
  ];

  const summary = summarizeNetworkAllowanceMetrics({
    startedAt,
    endedAt,
    fleets: { light: [instanceId] },
    series,
    capturedAt: "2026-07-28T00:05:00.000Z"
  });

  assert.equal(summary.verdict, "allowance_exceeded");
  assert.equal(summary.telemetry_complete, true);
  assert.deepEqual(summary.coverage, {
    expected_instance_metric_pairs: 5,
    complete_instance_metric_pairs: 5,
    partial_instance_metric_pairs: 0,
    missing_instance_metric_pairs: 0
  });
  const instance = summary.fleets[0].instances[0];
  assert.equal(
    instance.metrics.bandwidth_in_allowance_exceeded.delta_packets,
    9
  );
  assert.equal(instance.metrics.pps_allowance_exceeded.delta_packets, 5);
  assert.equal(
    instance.metrics.pps_allowance_exceeded.series[0].reset_count,
    1
  );
  assert.equal(
    summary.fleets[0].metrics.pps_allowance_exceeded.maximum_delta_packets,
    5
  );
  assert.match(
    renderNetworkAllowanceMarkdown(summary),
    /AWS network allowance pressure was detected/
  );
});

test("network allowance summary is inconclusive when any expected metric is absent", () => {
  const instanceId = "i-generator0000001";
  const summary = summarizeNetworkAllowanceMetrics({
    startedAt,
    endedAt,
    fleets: { generators: [instanceId] },
    series: [
      metricSeries(instanceId, "bandwidth_in_allowance_exceeded", [1, 1, 1])
    ]
  });

  assert.equal(summary.verdict, "inconclusive");
  assert.equal(summary.telemetry_complete, false);
  assert.equal(summary.coverage.complete_instance_metric_pairs, 1);
  assert.equal(summary.coverage.missing_instance_metric_pairs, 4);
  assert.equal(
    summary.fleets[0].instances[0].metrics.pps_allowance_exceeded.status,
    "missing"
  );
  assert.match(
    renderNetworkAllowanceMarkdown(summary),
    /telemetry is incomplete/
  );
});

function metricSeries(
  instanceId: string,
  metricKey: string,
  values: number[]
): CounterSeries {
  const definition = NETWORK_ALLOWANCE_METRICS.find(
    (metric) => metric.key === metricKey
  );
  assert.ok(definition);
  return {
    id: `m_${metricKey}`,
    fleet: instanceId.startsWith("i-api") ? "light" : "generators",
    instanceId,
    metricKey,
    metricName: definition.metricName,
    dimensions: [
      { Name: "InstanceId", Value: instanceId },
      { Name: "interface", Value: "ens5" }
    ],
    result: {
      Id: `m_${metricKey}`,
      Timestamps: timestamps,
      Values: values,
      StatusCode: "Complete"
    }
  };
}
