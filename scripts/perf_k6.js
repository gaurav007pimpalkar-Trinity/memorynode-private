/* eslint-disable */
import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL;
const API_KEY = __ENV.MEMORYNODE_API_KEY;

if (!BASE_URL) {
  throw new Error("BASE_URL env is required (e.g., https://api-staging.memorynode.ai)");
}
if (!API_KEY) {
  throw new Error("MEMORYNODE_API_KEY env is required");
}

export const options = {
  vus: 5,
  duration: "30s",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<800"],
  },
};

function headers() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  };
}

export default function () {
  // Ingest
  const memRes = http.post(
    `${BASE_URL}/v1/memories`,
    JSON.stringify({ user_id: "u1", text: "hello world" }),
    { headers: headers() },
  );
  check(memRes, { "memories 2xx": (r) => r.status >= 200 && r.status < 300 });

  sleep(0.5);

  // Search
  const searchRes = http.post(
    `${BASE_URL}/v1/search`,
    JSON.stringify({ query: "hello", user_id: "u1" }),
    { headers: headers() },
  );
  check(searchRes, { "search 2xx": (r) => r.status >= 200 && r.status < 300 });

  sleep(0.5);

  // Context
  const contextRes = http.post(
    `${BASE_URL}/v1/context`,
    JSON.stringify({ query: "hello", user_id: "u1" }),
    { headers: headers() },
  );
  check(contextRes, { "context 2xx": (r) => r.status >= 200 && r.status < 300 });

  sleep(1);
}
