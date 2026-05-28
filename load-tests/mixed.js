// Traffic Pattern: MIXED LOAD (Bursts + Quiet Periods)

import http from "k6/http";
import { sleep, check } from "k6";

export const options = {
  stages: [
    { duration: "1m", target: 5 }, // Quiet period 1
    { duration: "30s", target: 80 }, // Burst 1
    { duration: "2m", target: 80 }, // Hold burst 1
    { duration: "1m", target: 5 }, // Quiet period 2
    { duration: "30s", target: 100 }, // Burst 2 (bigger)
    { duration: "2m", target: 100 }, // Hold burst 2
    { duration: "1m", target: 10 }, // Quiet period 3
    { duration: "30s", target: 60 }, // Burst 3 (medium)
    { duration: "2m", target: 60 }, // Hold burst 3
    { duration: "1m", target: 0 }, // Cool down
  ],
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.1"],
  },
};

export default function () {
  // Weighted mix: 60% reads, 40% writes (realistic ratio)
  const rand = Math.random();

  let res;
  if (rand < 0.6) {
    // GET /query — read request
    res = http.get("http://localhost:8080/query");
    check(res, {
      "query status is 200": (r) => r.status === 200,
    });
  } else {
    // POST /process — write request
    res = http.post(
      "http://localhost:8080/process",
      JSON.stringify({ data: `event-${Date.now()}`, user: `user-${__VU}` }),
      { headers: { "Content-Type": "application/json" } },
    );
    check(res, {
      "process status is 200": (r) => r.status === 200,
    });
  }

  sleep(0.1);
}
