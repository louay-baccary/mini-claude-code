# Mini Claude Code

A minimal coding agent in Node.js, modeled on how Claude Code works under the hood: an LLM agent loop with tool calling, file and shell tools, and a skills system with progressive disclosure and forked subagents.

Built as part of the [CodeCrafters](https://codecrafters.io) "Build your own Claude Code" challenge, where every stage is validated by an automated test suite.

## Features

- **Agent loop**: sends the conversation to the model, executes any requested tools, feeds results back, and repeats until the model gives a final answer. Includes a max-iteration safety net.
- **Tools**
  - `Read`: read a file
  - `Write`: create or overwrite a file (creates missing parent folders)
  - `Bash`: run shell commands and return stdout, stderr and exit code, with a timeout and output cap
  - `Skill`: let the model load a skill on its own
- **Skills** (following the [Agent Skills](https://agentskills.io) standard)
  - Discovered from `.claude/skills/<name>/SKILL.md`, with YAML frontmatter parsed by a small built-in parser
  - **Progressive disclosure**: only name and description are sent up front. The body loads when the skill is used, and bundled scripts run only when the body asks for them.
  - **Slash commands**: `/deploy staging eu-west` expands the skill body as the prompt
  - **Arguments**: `$ARGUMENTS`, `$ARGUMENTS[n]` and `$n` placeholders
  - **Stacking**: `/lint /test 42` expands several skills that share the same arguments
  - **Bundled scripts**: paths in a skill body resolve relative to the skill's own folder
  - **Model-invoked skills**: the model matches a request against skill descriptions and calls the `Skill` tool
  - **Forked subagents**: skills with `context: fork` run in a separate agent loop with an isolated conversation, and only their answer returns to the main agent

## Architecture

```
prompt ──► resolvePrompt (slash commands, stacking, arguments)
              │
              ▼
          runAgent(messages, tools) ◄──────────────┐
              │                                     │
              ├─ no tool calls ──► final answer     │
              │                                     │
              └─ tool calls ──► executeTool ────────┘
                                   ├─ Read / Write / Bash
                                   └─ Skill
                                        ├─ inline ──► skill body as tool result
                                        └─ fork ───► runAgent(new messages) ──► answer only
```

The main agent and subagents share one `runAgent` function. A subagent is the same loop over a fresh message list, with no `Skill` tool, so forks can't recurse.

## Quick start

Requires Node.js 20.6+ and an [OpenRouter](https://openrouter.ai) API key.

```bash
npm install
```

Create a `.env` file in the project root:

```dotenv
OPENROUTER_API_KEY=sk-or-v1-...
MAX_TOKENS=4096        # optional, caps output per request
```

Run it:

```bash
node --env-file=.env app/main.js -p "Say hello in one word"
node --env-file=.env app/main.js -p "Read README.md and summarize it"
node --env-file=.env app/main.js -p "/deploy staging eu-west"
```

The agent works in the directory it's launched from and can create and delete files there, so try it in a sandbox folder. The [testing guide](docs/TESTING.md) shows how.

Debug output (tool calls, skill loading, subagent activity) goes to stderr. Only the final answer goes to stdout, so the output can be piped.

## Documentation

- **[Testing guide](docs/TESTING.md)**: step-by-step setup and 13 manual tests covering every feature, with expected output and troubleshooting
- **[Code walkthrough](docs/CODE_WALKTHROUGH.md)**: how the agent loop, tools, skills and subagents are implemented, and why

## Example skill

```
.claude/skills/checksum/
├── SKILL.md
├── data.txt
└── scripts/
    └── checksum.sh
```

```markdown
---
name: checksum
description: Use this skill when the user asks for the checksum of the data file.
---

Run `scripts/checksum.sh` using the Bash tool.
Respond with only the value it prints.
```

Add `context: fork` to the frontmatter to run the skill in an isolated subagent.

## Stack

Node.js (ES modules), the `openai` SDK pointed at OpenRouter's OpenAI-compatible API, and Claude Haiku 4.5 as the default model.
