import http from "k6/http";
import { sleep, check } from "k6";

export const options = {
  stages: [
    { duration: "1m", target: 5 }, // Start — minimal traffic
    { duration: "10m", target: 100 }, // RAMP — slow, steady increase
    { duration: "2m", target: 100 }, // Hold — peak load
    { duration: "2m", target: 0 }, // Cool down
  ],
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.1"],
  },
};

export default function () {
  const isRead = Math.random() > 0.5;

  let res;
  if (isRead) {
    res = http.get("http://localhost:8080/query");
    check(res, {
      "query status is 200": (r) => r.status === 200,
    });
  } else {
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
