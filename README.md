# Autonomous Infrastructure Scaling Agent

## 📖 Research Overview
Modern cloud infrastructure heavily relies on rule-based, reactive scaling (e.g., scaling up only after CPU exceeds 80%). This reactive model fundamentally fails during sudden traffic spikes (the "Thundering Herd" problem), causing users to experience severe latency while new servers boot up.

This research project proposes and empirically validates an **Autonomous Infrastructure Agent** driven by AI (Large Language Models). By analyzing real-time time-series telemetry data, the agent predicts traffic spikes and proactively scales infrastructure before performance degrades, shifting the paradigm from **reactive** to **predictive** auto-scaling.

## 🏗️ Architecture & Tech Stack
The project features a containerized, distributed systems environment to serve as a realistic "sandbox" for the AI agent:
- **Application Layer**: Node.js API simulating microservices.
- **Load Balancing**: Nginx (Layer 7) distributing traffic across dynamic replicas.
- **Telemetry & Monitoring**: Prometheus (with DNS Service Discovery) and Grafana for real-time metrics.
- **Data Persistence**: PostgreSQL and Redis.
- **AI Agent Reasoner**: Groq API utilizing `llama-3.1-8b-instant` for ultra-fast, low-latency reasoning based on the **Observe-Reason-Act** loop.
- **Load Testing**: `k6` to simulate asynchronous, high-concurrency traffic patterns.

## 📂 Repository Structure
```
.
├── agent/                  # AI Agent logic (Observe-Reason-Act loop)
│   ├── agent.js            # Main autonomous scaler script
│   └── test-models.js      # Utility to benchmark Groq models
├── api/                    # Node.js API application source code
├── baseline/               # Control group rule-based scaler
│   └── scaler.js           # Traditional reactive scaling script
├── load-tests/             # k6 simulation scripts
│   └── spike.js            # Spike test (5 to 500 concurrent users)
├── results/                # Output metrics and decision logs
├── docker-compose.yml      # Infrastructure orchestration
├── nginx.conf              # Load balancer configuration
└── prometheus.yml          # Prometheus monitoring configuration
```

## 🚀 Getting Started

### Prerequisites
- Docker & Docker Compose
- Node.js (v18+)
- [k6](https://k6.io/docs/get-started/installation/) (for load testing)
- Groq API Key

### Setup & Installation
1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd autonomous-infra-agent
   ```

2. **Start the infrastructure stack:**
   This will boot up the API, Nginx, Prometheus, Grafana, Postgres, and Redis.
   ```bash
   docker-compose up -d
   ```

3. **Install agent dependencies:**
   ```bash
   cd agent
   npm install
   cd ..
   ```

4. **Configure your AI Reasoning API Key:**
   ```bash
   export GROQ_API_KEY="gsk_your_api_key_here"
   ```

## 🔬 Running the Experiments

The research methodology involves a two-phase experiment to compare reactive scaling vs. predictive AI scaling.

### Phase 1: The Control Group (Rule-Based Baseline)
Establish the baseline performance by running a traditional rule-based scaler. This system reacts to latency breaches.
1. Start the baseline scaler:
   ```bash
   node baseline/scaler.js
   ```
2. In a separate terminal, trigger the spike load test:
   ```bash
   k6 run load-tests/spike.js
   ```
*Observe the latency degradation and container cold-start delays.*

### Phase 2: The Autonomous AI Agent
Deploy the AI agent, which reads the same Prometheus telemetry but utilizes predictive pattern recognition.
1. Start the AI agent:
   ```bash
   node agent/agent.js
   ```
2. In a separate terminal, trigger the identical load test:
   ```bash
   k6 run load-tests/spike.js
   ```

### 📊 Viewing Telemetry & Results
- **Grafana Dashboards:** `http://localhost:3100` (Credentials: `admin` / `admin`)
- **Prometheus Raw Metrics:** `http://localhost:9090`
- **Agent Decision Logs:** The AI's reasoning and scaling decisions are automatically logged to `results/agent_decisions.csv` for post-experiment analysis.
