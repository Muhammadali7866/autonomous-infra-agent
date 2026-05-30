import http from "k6/http";
import { sleep, check } from "k6";

export const options = {
  //defne these options so k6 can read it while working
  stages: [
    { duration: "30s", target: 5   }, // Warm up — normal low traffic
    { duration: "10s", target: 500 }, // SPIKE — instant surge to 500 users
    { duration: "3m",  target: 500 }, // Hold  — sustained high load 
    { duration: "30s", target: 0   }, // Cool down — ramp back to zero
  ],
  thresholds: {
    // pass/fail criteria
    http_req_duration: ["p(95)<500"], // 95% of requests should be under 500ms
    http_req_failed: ["rate<0.1"], // Error rate should stay below 10%
  },
};

export default function () {
  // Send a POST request to /process (simulates a user creating data)
  const res = http.post(
    "http://localhost:8080/process",
    JSON.stringify({ data: `event-${Date.now()}`, user: `user-${__VU}` }), // sending dummy data to api
    { headers: { "Content-Type": "application/json" } },
  );

  // Check the response is valid
  check(res, {
    "status is 200": (r) => r.status === 200,
    "response has success": (r) => r.json("success") === true,
  });

  sleep(0.1); // 100ms between requests per virtual user
}
