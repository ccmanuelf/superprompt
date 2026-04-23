# Developer Pack — Level 3 Feature Workflow

## Overview

This pack manages the lifecycle of Level 3 feature requests — features that require web UI development, new server routes, or TypeScript code changes that can't be created conversationally.

It implements a 13-step workflow where luna handles intake, documentation, scheduling, code drafting, and monitoring, while the dev team handles review, approval, and deployment.

## The 13-Step Workflow

| Step | Actor | What happens |
|------|-------|-------------|
| 1 | User | Describes the desired feature in conversation |
| 2 | luna (feature-architect skill) | Guides user through structured PRD conversation: problem → workflow → outcome → scope → success criteria |
| 3 | luna | Creates kanban card with PRD document attached |
| 4 | luna | Notifies user: "Request will be reviewed during off-hours" |
| 5 | luna (off-hours) | Reviews PRD draft, starts coding the feature |
| 6 | luna | Assigns review task to dev team, notifies them |
| 7 | luna | Notifies user: "Submitted to dev team, expect response in 48h" |
| 8 | Dev team | Reviews code and PRD, marks task as reviewed |
| 9 | luna | Monitors card status, notifies user of changes |
| 10 | Dev team (if approved) | Adjusts code, commits, marks as approved |
| 11 | Dev team (if rejected) | Cancels task, includes reasons |
| 12 | luna (off-hours) | Verifies commit, deploys during off-hours, runs tests |
| 13 | luna | Notifies user, marks kanban card as completed |

## Skills

### feature-architect
- **Trigger:** "I need a new dashboard", "build me a feature"
- **Mode:** Suggest (user can accept or dismiss)
- **What it does:** 5-phase conversation (problem, workflow, outcome, scope, criteria)
- **Output:** Structured requirement data for the PRD writer

### prd-writer
- **Trigger:** "Generate the PRD", "create the requirements document"
- **Mode:** Auto
- **What it does:** Generates formal DOCX/PDF with 10 sections
- **Output:** Document file + kanban card

## Tools

### feature_request
- **Actions:** create, status, list, review_complete, approve, reject, deploy_verify
- **Used by:** Skills (automated) and dev team (manual commands)
- **Bilingual:** All notifications in EN/ES

## Usage

### For users (via Telegram):
```
"I need a new dashboard for tracking production orders"
→ luna activates feature-architect skill
→ Guides through PRD conversation
→ Generates document and kanban card
→ User waits for dev team response
```

### For dev team (via Telegram commands):
```
/board                           # See pending feature requests
/board show <card-id>            # Review PRD and code
feature_request approve <id>     # Approve for deployment
feature_request reject <id>      # Reject with reason
```

## Configuration

No configuration needed. The pack auto-loads from the `packs/developer/` directory on luna restart.

## Dependencies

- Kanban board (built-in)
- Document generation (built-in)
- Background task queue (WS2)
- Event triggers (WS2)
- Proactive notifications (built-in)
