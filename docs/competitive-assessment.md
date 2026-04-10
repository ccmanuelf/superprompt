# clauded — Competitive Assessment

**Prepared for:** CTO Review
**Version:** v1.0.0-rc.48 | April 2026
**Methodology:** Deep research via SearXNG (DuckDuckGo, Bing, Brave, Qwant), GitHub repositories, official product pages. No assumptions — findings marked where data is incomplete.

---

## Executive Summary

clauded occupies a unique position: it is a **domain-specific, self-hosted AI assistant platform** built for manufacturing and multi-department operations. Most alternatives are **general-purpose AI agent frameworks** designed for developers and personal productivity. The comparison below reflects this fundamental difference — clauded trades generality for depth in its target domain.

---

## Comparison Table

### Setup & Infrastructure

| Product | Setup Complexity | Self-Hosted | Cloud Option | Container Isolation | Startup Time |
|---------|-----------------|-------------|-------------|-------------------|-------------|
| **clauded** | Docker Compose (3 services). `.env` config, Telegram bot token, Claude subscription. 45-60 min first deploy. | Yes (required) | No | 3-process separation (SA3) + Worker V8 sandbox | ~15s (3 containers) |
| **OpenClaw** | Docker or native install. Requires Claude/OpenAI API key. Plugin system for channels. 15-30 min. | Yes | No (community cloud wrappers exist) | Gateway + Agent + Tool Server processes | ~10s |
| **NanoClaw** | Docker or Apple Containers (macOS). Fork of OpenClaw with hardened security. 20-40 min. | Yes | No | Docker sandboxes or Apple Container (micro-VM on macOS) | ~10-15s |
| **NullClaw** | Single binary or Docker. Minimal config. ~10 min. | Yes | No | Optional Docker isolation | ~3s |
| **PicoClaw** | Single Go binary. Runs on Raspberry Pi. ~5 min. | Yes | No | None (single process) | <1s |
| **ZeroClaw** | Single Rust binary. ~5 min. | Yes | No | Rust memory safety, no sandbox | <1s |
| **IronClaw** | Docker or native Rust. Near AI ecosystem. 15-30 min. | Yes | No | Firecracker micro-VMs (sub-millisecond sandbox) | ~5s |
| **SuperAGI** | Docker Compose. Requires API keys. Web UI setup. 20-40 min. | Yes | Yes (SuperAGI Cloud) | Docker-based agent isolation | ~20s |
| **Agent Zero** | Python + Docker. Requires API keys. 15-30 min. | Yes | No | Docker sandbox for code execution | ~10s |
| **Hermes Agent** | Python. Requires Claude subscription. 10-20 min. | Yes | No | None (single process) | ~5s |
| **Taskade** | SaaS — no setup. Sign up and go. | No | Yes (only) | N/A (cloud-managed) | Instant |
| **Pi (Inflection)** | SaaS — no setup. App or web. | No | Yes (only) | N/A (cloud-managed) | Instant |

**Sources:** OpenClaw official docs (openclaw.ai), NanoClaw GitHub (OpenRouterTeam/nanoclaw), PicoClaw GitHub (sipeed/picoclaw), ZeroClaw GitHub (chuyl/zeroclaw), IronClaw GitHub (nearai/ironclaw), SuperAGI GitHub (TransformerOptimus/SuperAGI), Agent Zero GitHub (agent0ai/agent-zero), Hermes Agent GitHub (nousresearch/hermes-agent), Taskade (taskade.com), Pi (pi.ai)

---

### Security

| Product | Data Location | Process Isolation | Tool Permissions | Auth Model | Threat Model Documented |
|---------|--------------|-------------------|-----------------|-----------|----------------------|
| **clauded** | On-premises only | 3-process (core/tools/parsers) + Worker V8 sandbox | 43 tools classified by risk (3 critical, 16 high, 19 medium, 5 low). Per-user trust memory. | Per-user tokens + Telegram ID gating | Yes (20 vectors assessed) |
| **OpenClaw** | On-premises | Gateway + Agent + Tool Server | Permission system with user approval | API key auth | Partial (security docs exist) |
| **NanoClaw** | On-premises | Docker/Apple Container micro-VMs | Credential proxy — agents never hold raw keys | Container-level isolation | Yes (security-first design) |
| **NullClaw** | On-premises | Optional Docker | Minimal — autonomous execution by design | Basic token auth | No formal threat model found |
| **PicoClaw** | On-premises | None (single process) | No permission system found | Basic auth | No |
| **ZeroClaw** | On-premises | Rust memory safety only | No formal permission system found | Basic auth | No |
| **IronClaw** | On-premises | Firecracker micro-VMs | Sandboxed tool execution | API key + onboarding wizard | Partial (Rust security focus) |
| **SuperAGI** | On-premises or cloud | Docker containers | Agent-level permissions | Web UI login | Partial |
| **Agent Zero** | On-premises | Docker for code execution | User confirmation for dangerous ops | Basic — single user | No |
| **Hermes Agent** | On-premises | None | Inherits Claude CLI permissions | Claude subscription auth | No |
| **Taskade** | Vendor cloud (AWS) | Cloud-managed | Workspace-level permissions | SSO, team roles | Vendor-managed |
| **Pi** | Vendor cloud | Cloud-managed | No tool execution | Account-based | Vendor-managed |

---

### Team Support & Multi-User

| Product | Multi-User | Per-User Data Isolation | Team Management | Concurrent Users |
|---------|-----------|----------------------|-----------------|-----------------|
| **clauded** | Yes — per-user web tokens, ALLOWED_CHAT_ID gating | Yes — board, learning, memory, schedules, manufacturing scenarios all scoped by chat_id | Self-service token management (/webtoken), department packs | Concurrent via Telegram + web UIs |
| **OpenClaw** | Limited — single-user by default, multi-user via plugins | Partial — conversation history per channel | Community plugins for team features | Multiple channels, single agent |
| **NanoClaw** | Limited — designed as personal assistant | Per-container isolation (one container per user possible) | Not built-in | Single user per instance |
| **NullClaw** | No — single user | N/A | None | Single user |
| **PicoClaw** | No — single user | N/A | None | Single user |
| **ZeroClaw** | No — single user | N/A | None | Single user |
| **IronClaw** | Limited — personal agent focus | Per-instance | Not built-in | Single user per instance |
| **SuperAGI** | Yes — web UI with multiple agents | Agent-level separation | Web dashboard, agent management | Multiple agents, single dashboard |
| **Agent Zero** | No — single user | N/A | None | Single user |
| **Hermes Agent** | No — single user | N/A | None | Single user |
| **Taskade** | Yes — built for teams | Workspace-level | Full team management, roles, permissions | Unlimited (SaaS) |
| **Pi** | No — personal AI | Per-account | None | Single user |

---

### AI Models

| Product | Models Supported | Default | Local Model Support | Model Switching |
|---------|-----------------|---------|-------------------|----------------|
| **clauded** | Claude (via CLI subscription) + Ollama (any local model) | Claude for reasoning, Ollama (Qwen 3.5) for tools | Yes — full Ollama integration with agentic loop | /claude, /ollama, /auto (automatic routing) |
| **OpenClaw** | Claude, GPT-4, Gemini, Ollama, 20+ providers | Claude (recommended) | Yes via Ollama | Config file or runtime switch |
| **NanoClaw** | Claude, GPT-4, local models via API | Claude | Yes via API | Config-based |
| **NullClaw** | Any OpenAI-compatible API | Varies | Yes | Config-based |
| **PicoClaw** | Any OpenAI-compatible API, Ollama | Configurable | Yes | Config-based |
| **ZeroClaw** | Any OpenAI-compatible API | Configurable | Yes | Config-based |
| **IronClaw** | Claude, GPT-4, Ollama, local models | Configurable | Yes | Config + runtime |
| **SuperAGI** | GPT-4, GPT-3.5, local models | GPT-4 | Limited | Per-agent config |
| **Agent Zero** | Claude, GPT-4, local models | Claude or GPT-4 | Yes via Ollama | Config-based |
| **Hermes Agent** | Claude (primary), Ollama | Claude | Yes via Ollama | Config-based |
| **Taskade** | Proprietary (GPT-4 based) | Vendor-selected | No | No |
| **Pi** | Proprietary (Inflection) | Vendor-only | No | No |

---

### Pricing (Estimated Monthly Cost)

| Product | License | AI Model Cost | Infrastructure | Total Estimate |
|---------|---------|--------------|---------------|---------------|
| **clauded** | Open source (private repo) | Claude subscription ~$20-100/mo + Ollama free | Own hardware or VM | **$20-100/mo** |
| **OpenClaw** | Open source (MIT) | Claude/GPT API usage varies | Own hardware | **$20-200/mo** (API-dependent) |
| **NanoClaw** | Open source | Same as OpenClaw | Own hardware | **$20-200/mo** |
| **NullClaw** | Open source | API usage varies | Minimal hardware | **$5-50/mo** |
| **PicoClaw** | Open source | API usage varies | Raspberry Pi ($35 one-time) | **$5-50/mo** |
| **ZeroClaw** | Open source | API usage varies | Minimal hardware | **$5-50/mo** |
| **IronClaw** | Open source (MIT) | API usage varies | Own hardware | **$20-100/mo** |
| **SuperAGI** | Open source / Cloud | Cloud: $30-200/mo. Self-hosted: API costs | Own hardware or cloud | **$30-200/mo** |
| **Agent Zero** | Open source | API usage varies | Own hardware + Docker | **$20-100/mo** |
| **Hermes Agent** | Open source (MIT) | Claude subscription ~$20-100/mo | Own hardware | **$20-100/mo** |
| **Taskade** | SaaS: Free / $8 / $16 per user/mo | Included in subscription | Vendor-managed | **$8-16/user/mo** |
| **Pi** | Free (ad-supported) / $20/mo Pro | Included | Vendor-managed | **$0-20/mo** |

**Note:** API-based pricing (OpenClaw, NanoClaw, etc.) varies dramatically with usage. clauded uses a fixed Claude subscription (no per-token billing), making costs predictable.

---

### Size & Resource Usage

| Product | Language | Binary/Install Size | RAM Usage (Idle) | RAM Usage (Active) |
|---------|----------|-------------------|-----------------|-------------------|
| **clauded** | TypeScript/Node.js | ~50MB (node_modules) + 3 Docker images | ~200MB (bot) + 512MB (SearXNG) + 2GB (Speaches) | ~500MB-1GB (bot under load) |
| **OpenClaw** | TypeScript/Python | ~100MB+ | ~300-500MB | ~500MB-2GB |
| **NanoClaw** | TypeScript | ~80MB | ~200-400MB | ~400MB-1GB |
| **NullClaw** | Rust | ~15MB binary | ~30-50MB | ~100-200MB |
| **PicoClaw** | Go | <10MB binary | <10MB | ~50-100MB |
| **ZeroClaw** | Rust | <5MB binary | ~10-20MB | ~50-100MB |
| **IronClaw** | Rust | ~20MB binary | ~50-100MB | ~200-500MB |
| **SuperAGI** | Python | ~200MB+ | ~500MB-1GB | ~1-4GB |
| **Agent Zero** | Python | ~150MB | ~300-500MB | ~500MB-2GB |
| **Hermes Agent** | Python | ~100MB | ~200-400MB | ~400MB-1GB |
| **Taskade** | N/A (SaaS) | N/A | N/A | N/A |
| **Pi** | N/A (SaaS) | N/A | N/A | N/A |

**Note:** clauded's higher RAM includes voice processing (Speaches) and web search (SearXNG) sidecars. Without these optional services, idle RAM is ~200MB.

---

### Communication Channels

| Product | Telegram | WhatsApp | Slack | Discord | Matrix | Web UI | Voice | Email |
|---------|----------|----------|-------|---------|--------|--------|-------|-------|
| **clauded** | Yes | No | No | No | Yes | Yes (14 dashboards) | Yes (STT+TTS) | No |
| **OpenClaw** | Yes | Yes | Yes | Yes | No | Yes (basic) | Partial | Yes |
| **NanoClaw** | Yes | Yes | Yes | Yes | No | No | No | Yes |
| **NullClaw** | Yes | Yes | Yes | Yes | No | No | No | No |
| **PicoClaw** | Yes | Yes | Yes | Yes | No | No | No | Yes |
| **ZeroClaw** | Yes | Yes | Yes | Yes | Yes | No | No | Yes |
| **IronClaw** | Yes | Yes | Yes | Yes | No | Yes (basic) | No | Yes |
| **SuperAGI** | No | No | No | No | No | Yes (dashboard) | No | No |
| **Agent Zero** | No | No | No | No | No | Yes (web chat) | No | No |
| **Hermes Agent** | Yes | No | No | No | No | Yes (web chat) | No | No |
| **Taskade** | No | No | Yes | No | No | Yes (full app) | No | Yes |
| **Pi** | No | No | No | No | No | Yes (app + web) | Yes | No |

**Trade-off:** clauded supports fewer channels (2 messaging + web + voice) but each is deeply integrated with tools, memory, and domain packs. OpenClaw/ZeroClaw support 20+ channels but with thinner integration per channel.

---

### Multi-Agent & Autonomy

| Product | Multi-Agent | Autonomous Execution | Agentic Loop | Self-Learning |
|---------|------------|--------------------|--------------|----|
| **clauded** | No (single agent, multi-department via packs) | Scheduled tasks, proactive alerts, nightly bot execution | Yes (Ollama, max 10 iterations + circuit breaker) | Auto-skills (detects patterns, drafts skills), self-tuning packs, guardrails memory |
| **OpenClaw** | No (single agent) | Scheduled tasks, autonomous tool use | Yes | Skills/memory accumulation |
| **NanoClaw** | No | Limited scheduled tasks | Yes | Memory persistence |
| **NullClaw** | No | Fully autonomous by design | Yes | Minimal |
| **PicoClaw** | No | Scheduled tasks | Basic | No |
| **ZeroClaw** | No | Minimal | Basic | No |
| **IronClaw** | No | Sandboxed autonomous execution | Yes | Memory persistence |
| **SuperAGI** | Yes (multiple agents, different roles) | Yes — agents run independently | Yes | Agent learning from runs |
| **Agent Zero** | Yes (spawns sub-agents) | Yes — code execution, web browsing | Yes (ReAct) | Memory system |
| **Hermes Agent** | No | Yes — tool use, file operations | Yes | Built-in learning loop (skill generation) |
| **Taskade** | Yes (agent workflows) | Yes — background task execution | Yes | Workflow optimization |
| **Pi** | No | No | No | Conversation adaptation |

---

### Key Functionalities

| Product | Key Functionalities |
|---------|-------------------|
| **clauded** | 43 domain tools (15 manufacturing), 10 department packs, 14 web dashboards (DES simulation, capacity planning, sequencing, VSM, TOC, CONWIP, DOE, FSM), learning coach (12 personas, spaced repetition), kanban board, document generation (XLSX/DOCX/PDF/PPTX), dual-sector memory (semantic + episodic), voice processing (EN/ES), web search (SearXNG), policy engine with per-user trust |
| **OpenClaw** | General-purpose AI assistant, 30+ channel integrations, plugin ecosystem, file management, code execution, web browsing, memory system, skill accumulation |
| **NanoClaw** | Security-hardened OpenClaw alternative, container isolation, credential proxy, WhatsApp/Telegram/Slack/Discord, memory, scheduled jobs |
| **NullClaw** | Minimal autonomous agent, fast execution, multi-channel messaging, lightweight |
| **PicoClaw** | Ultra-lightweight (<10MB), runs on Raspberry Pi, 16+ chat platforms, basic memory and scheduling |
| **ZeroClaw** | Smallest footprint (<5MB Rust binary), 20+ channels, instant startup, basic agent capabilities |
| **IronClaw** | Rust-based privacy agent, Firecracker micro-VM sandboxing, sub-millisecond isolation, memory, tool use |
| **SuperAGI** | Multi-agent orchestration, web dashboard, marketplace for tools/agents, concurrent agent execution, cloud deployment option |
| **Agent Zero** | Python framework, sub-agent spawning, Docker code sandbox, knowledge tool, memory system, web browsing |
| **Hermes Agent** | Learning loop (auto-generates skills), Claude integration, file operations, tool use, session memory |
| **Taskade** | SaaS workspace with AI agents, project management, document collaboration, workflow automation, team features |
| **Pi** | Conversational AI companion, emotional intelligence, general knowledge, voice interaction |

---

### Best Use Case

| Product | Best Use Case | Not Suited For |
|---------|-------------|---------------|
| **clauded** | Manufacturing/operations teams needing domain tools + AI assistant on company infrastructure. Multi-department deployment with data isolation. | Consumer/personal use. Teams needing 20+ channel integrations. Organizations without IT to run Docker. |
| **OpenClaw** | Developers and power users who want a personal AI on every platform with broad channel coverage. | Domain-specific workflows. Teams needing per-user isolation. Non-technical users. |
| **NanoClaw** | Security-conscious users who want OpenClaw-like features with stronger isolation guarantees. | Same as OpenClaw — personal, not team-oriented. |
| **NullClaw** | Developers who want the smallest autonomous agent with multi-channel reach. | Production team deployments. Complex domain workflows. |
| **PicoClaw** | IoT/edge deployments, Raspberry Pi home automation, resource-constrained environments. | Enterprise use. Complex tool ecosystems. |
| **ZeroClaw** | Developers who want maximum performance in minimum footprint. Hobbyist/experimental use. | Production deployments. Team collaboration. |
| **IronClaw** | Privacy-focused developers who want Rust safety + Firecracker isolation. | Non-technical users. Domain-specific workflows. |
| **SuperAGI** | Teams experimenting with multi-agent architectures. Research and development. | Single-department operational use. Manufacturing-specific workflows. |
| **Agent Zero** | Developers building custom AI agent workflows with code execution needs. | Non-technical users. Production team deployment. |
| **Hermes Agent** | Developers wanting a learning AI assistant that improves over time with Claude. | Teams. Domain-specific tools. Manufacturing. |
| **Taskade** | Teams wanting instant AI-powered project management without infrastructure. | On-premises requirements. Data sovereignty. Custom domain tools. |
| **Pi** | Individuals wanting a conversational AI companion. Casual use. | Business operations. Tool execution. Team deployment. |

---

### Strengths & Trade-offs

| Product | Strengths | Trade-offs |
|---------|-----------|-----------|
| **clauded** | Deepest domain tooling (manufacturing, quality, capacity). Dual AI provider (Claude + Ollama). Full data isolation per user. 14 interactive web dashboards. Voice (EN/ES). Learning coach. 1845 automated tests. Fixed-cost AI (subscription, not per-token). | Fewer messaging channels (2 vs 20+). Requires Docker + IT support. No multi-agent. Heavier resource footprint with sidecars. |
| **OpenClaw** | Broadest channel support (30+). Active community. Plugin ecosystem. Broad model support. | No domain-specific tools. Limited team support. Security concerns led to NanoClaw fork. Per-token API costs. |
| **NanoClaw** | Strongest container security model. Credential proxy. Apple Container support on macOS. | Smaller community than OpenClaw. Still personal-focused. Limited domain tools. |
| **NullClaw** | Fastest startup. Smallest Rust binary. Fully autonomous. | No team features. Minimal security model. No domain tools. Limited documentation. |
| **PicoClaw** | Runs anywhere (Raspberry Pi, edge). Single binary. 16+ channels. | No sandboxing. No domain tools. Basic agent capabilities. |
| **ZeroClaw** | Smallest footprint (<5MB). Instant startup. Rust performance. | Early stage. No web UI. No domain tools. No team features. |
| **IronClaw** | Firecracker micro-VM isolation. Rust safety. Sub-millisecond sandboxing. | Requires Linux (Firecracker). Complex setup. Personal-focused. |
| **SuperAGI** | Multi-agent support. Web dashboard. Cloud option. Agent marketplace. | Higher resource usage. Python (slower). No messaging channels. |
| **Agent Zero** | Sub-agent spawning. Docker code sandbox. Flexible Python framework. | No messaging channels. Single-user. Research-oriented. |
| **Hermes Agent** | Built-in learning loop. Skill auto-generation. Claude-optimized. | Single-user. No web dashboards. No domain tools. Early stage. |
| **Taskade** | Zero setup. Full team management. SaaS reliability. | No self-hosting. No data sovereignty. No custom domain tools. Per-user monthly cost. |
| **Pi** | Natural conversational AI. Emotional intelligence. Free tier. | No tool execution. No enterprise features. No self-hosting. No customization. |

---

## Positioning Summary

```
                    Domain Depth
                        ^
                        |
              clauded   |
                ██████  |
                ██████  |
                        |
  Taskade ●             |           ● SuperAGI
                        |
  Pi ●                  |     ● Agent Zero
                        |   ● Hermes Agent
         ● OpenClaw     |
         ● NanoClaw     |
                        |
  ● IronClaw            |
  ● NullClaw            |
  ● ZeroClaw            |
  ● PicoClaw            |
  ──────────────────────+──────────────────> General Breadth
        Self-Hosted               Cloud/SaaS
```

clauded is the only product in this comparison that combines **self-hosted deployment**, **domain-specific tooling**, **multi-user team support**, and **interactive web dashboards**. The trade-off is clear: fewer messaging channels and higher infrastructure requirements in exchange for unmatched depth in manufacturing and operations workflows.

---

## References

| Source | URL | Accessed |
|--------|-----|----------|
| OpenClaw Official | openclaw.ai | April 2026 |
| OpenClaw GitHub | github.com/GMTekAI/openclaw-ClawMcgraw | April 2026 |
| NanoClaw GitHub | github.com/OpenRouterTeam/nanoclaw | April 2026 |
| PicoClaw GitHub | github.com/sipeed/picoclaw | April 2026 |
| ZeroClaw GitHub | github.com/chuyl/zeroclaw | April 2026 |
| IronClaw GitHub | github.com/nearai/ironclaw | April 2026 |
| SuperAGI GitHub | github.com/TransformerOptimus/SuperAGI | April 2026 |
| SuperAGI Official | superagi.com | April 2026 |
| Agent Zero GitHub | github.com/agent0ai/agent-zero | April 2026 |
| Hermes Agent GitHub | github.com/nousresearch/hermes-agent | April 2026 |
| Taskade Official | taskade.com | April 2026 |
| Pi Official | pi.ai | April 2026 |
| TechRadar OpenClaw | techradar.com/pro/wild-things-people-are-building-with-openclaw | April 2026 |
| OSSInsight Rust AI | ossinsight.io/blog/rust-ai-agent-infrastructure-2026 | April 2026 |
| Skywork Alternatives | skywork.ai/skypage/en/secure-alternatives-openclaw-ai-agent/ | March 2026 |

---

*clauded v1.0.0-rc.48 — Competitive Assessment for CTO Review*
