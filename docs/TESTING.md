# Testing Guide

A step-by-step guide to running the agent locally and checking each feature by hand.

Every test runs in a throwaway sandbox folder. The agent can create, overwrite and delete files through its `Write` and `Bash` tools, and it works in whatever directory you launch it from, so never test it inside a folder you care about.

---

## 1. Prerequisites

| Requirement | Check | Notes |
|---|---|---|
| Node.js 20.6+ | `node -v` | Needed for the `--env-file` flag |
| npm | `npm -v` | Comes with Node |
| OpenRouter API key | [openrouter.ai/keys](https://openrouter.ai/keys) | Needs a little credit; each test run costs a fraction of a cent |
| `python3`, `sha256sum` | `which python3 sha256sum` | Only used by some tests |

---

## 2. Setup

### 2.1 Install dependencies

```bash
cd path/to/mini-claude-code
npm install
```

Check that the SDK is installed:

```bash
ls node_modules/openai
```

### 2.2 Create the `.env` file

In the project root, create `.env` with your key **and its value**:

```dotenv
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxx

# Optional
MAX_TOKENS=4096
# OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

`.env` is listed in `.gitignore`, so it is never committed. Confirm with `git status`: `.env` must not appear.

### 2.3 Create a sandbox and an alias

```bash
mkdir -p /tmp/agent-sandbox && cd /tmp/agent-sandbox
```

Define the alias **on its own line** (replace the path with yours):

```bash
alias agent="node --env-file=$HOME/path/to/mini-claude-code/.env $HOME/path/to/mini-claude-code/app/main.js"
```

To keep it across terminals, append the same line to `~/.zshrc` or `~/.bashrc` and run `source ~/.zshrc`.

> In zsh, use an alias rather than `AGENT="node ..."` followed by `$AGENT`. zsh does not split variables on spaces, so `$AGENT` fails with "no such file or directory".

---

## 3. Reading the output

- **stdout**: only the model's final answer.
- **stderr**: debug lines showing what happened, for example:

| Log line | Meaning |
|---|---|
| `[skills] greet, shout` | Skills discovered in `.claude/skills/` |
| `[skills] invoking /greet args="louay"` | A slash command was expanded |
| `[main tool #1] Read {"file_path":"notes.txt"}` | The main agent called a tool on iteration 1 |
| `[subagent:oncall] starting` | A forked skill started its own agent loop |
| `[subagent:oncall] returned "blueberry"` | The subagent's answer, before it reaches the main agent |

To see only the answer, add `2>/dev/null`. To see only the logs, add `>/dev/null`.

---

## 4. Tests

Run each block from `/tmp/agent-sandbox`. Model output can vary in wording; the **Expected** column describes what must be true.

### Test 1: Basic answer (no tools)

```bash
agent -p "Say hello in one word"
```

**Expected:** a single word such as `Hello`, and no `tool` lines on stderr.
**Verifies:** API key, model access, final-answer printing.

### Test 2: Read tool and agent loop

```bash
echo "The secret number is 42." > notes.txt
agent -p "Read notes.txt and tell me the secret number. Number only."
```

**Expected:** `42`, with `[main tool #1] Read {"file_path":"notes.txt"}` on stderr.
**Verifies:** tool calling, tool results fed back, loop termination.

### Test 3: Multi-step reasoning across files

```bash
mkdir -p app
echo "Config lives in app/settings.txt" > README.md
echo "timeout = 30 seconds" > app/settings.txt
agent -p "Use README.md to find the timeout value. Number only."
```

**Expected:** `30`, after two `Read` calls (README.md, then app/settings.txt).
**Verifies:** the loop runs several iterations until the answer is found.

### Test 4: Write tool

```bash
agent -p "Create greet/hello.txt containing exactly the line: hi there. Reply 'done'."
cat greet/hello.txt
```

**Expected:** `done`, and the file contains `hi there`. The `greet/` folder is created automatically.
**Verifies:** file creation and missing parent folders.

### Test 5: Bash tool

```bash
touch old_readme.md
agent -p "List the files with ls and delete the old readme file you find."
ls
```

**Expected:** `old_readme.md` is gone; other files are untouched. stderr shows a `Bash` call with `ls`, then one with `rm`.
**Verifies:** shell execution, output capture, multi-step tool use.

### Test 6: Write + Bash together

```bash
agent -p "Create hello.py that prints 'hi from python', run it with python3, and tell me the exact output."
```

**Expected:** `hi from python`.

### Test 7: Skill via slash command

```bash
mkdir -p .claude/skills/greet
cat > .claude/skills/greet/SKILL.md <<'EOF'
---
name: greet
description: Use this skill when the user wants to greet someone.
---

Respond with exactly: hello-$0
EOF

agent -p "/greet louay"
```

**Expected:** `hello-louay`. stderr shows `[skills] invoking /greet args="louay"` and **no** `Skill` tool call.
**Verifies:** skill discovery, slash commands, positional `$0`.

### Test 8: Arguments (`$ARGUMENTS`, `$0`, `$1`)

```bash
mkdir -p .claude/skills/swap
cat > .claude/skills/swap/SKILL.md <<'EOF'
---
name: swap
description: Swaps two words.
---

Respond with exactly: $1 $0 (full input was: $ARGUMENTS)
EOF

agent -p "/swap mango pear"
```

**Expected:** `pear mango (full input was: mango pear)`.

### Test 9: Stacking skills

```bash
mkdir -p .claude/skills/shout
cat > .claude/skills/shout/SKILL.md <<'EOF'
---
name: shout
description: Use this skill when the user wants something shouted.
---

Add this exact line to your response: LOUD-$ARGUMENTS
EOF

agent -p "/greet /shout 7"
```

**Expected:** output contains both `hello-7` and `LOUD-7`.

Edge cases to try:

| Prompt | Expected behavior |
|---|---|
| `/greet 7 /shout` | Only `greet` expands; its args are `7 /shout` |
| `/greet /nope 7` | Only `greet` expands; its args are `/nope 7` (no `nope` skill) |
| `/nope hello` | Unknown skill: the prompt is sent as-is, with a warning on stderr |

### Test 10: Skill with a bundled script

```bash
mkdir -p .claude/skills/checksum/scripts
echo "some data" > .claude/skills/checksum/data.txt
cat > .claude/skills/checksum/scripts/checksum.sh <<'EOF'
#!/usr/bin/env bash
cd "$(dirname "$0")/.." && sha256sum data.txt | cut -c1-8
EOF
chmod +x .claude/skills/checksum/scripts/checksum.sh
cat > .claude/skills/checksum/SKILL.md <<'EOF'
---
name: checksum
description: Use this skill when the user asks for the checksum of the data file.
---

Run `scripts/checksum.sh` using the Bash tool. Respond with only the value it prints.
EOF

agent -p "/checksum"
sha256sum .claude/skills/checksum/data.txt | cut -c1-8
```

**Expected:** both commands print the same 8-character hash. stderr shows `Bash {"command":".claude/skills/checksum/scripts/checksum.sh"}`.
**Verifies:** paths in a skill body resolve relative to the skill's folder.

### Test 11: Model-invoked skill

```bash
agent -p "What's the checksum of the data file?"
```

**Expected:** the same hash as Test 10. stderr shows `[main tool #1] Skill {"name":"checksum"}`, then a `Bash` call.
**Verifies:** the model matches the request to a skill description on its own.

### Test 12: Forked subagent

```bash
mkdir -p .claude/skills/oncall
cat > .claude/skills/oncall/SKILL.md <<'EOF'
---
name: oncall
description: Use this skill when the user asks who is on call.
context: fork
---

Respond with exactly one word: blueberry
EOF

agent -p "Who is on call right now?"
```

**Expected:** an answer containing `blueberry`. stderr shows:

```
[main tool #1] Skill {"name":"oncall"}
[subagent:oncall] starting
[subagent:oncall] returned "blueberry"
```

**Verifies:** the forked skill runs in its own loop, its conversation holds only the skill body (not the user's question), and only its answer returns to the main agent.

### Test 13: Error handling

```bash
agent -p "Read the file does_not_exist.txt and tell me what happened."
```

**Expected:** the model explains the file doesn't exist. The program does not crash, because the `ENOENT` error is returned to the model as a tool result.

---

## 5. Cleanup

```bash
rm -rf /tmp/agent-sandbox
```

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `OPENROUTER_API_KEY is not set` | `.env` not loaded, or the key has no value | Check the `--env-file` path in the alias and use the `KEY=value` format |
| `zsh: no such file or directory: node --env-file=...` | zsh does not split `$VAR` on spaces | Use the `agent` alias, or `${=AGENT}` |
| `zsh: command not found: agent` right after defining the alias | Alias and command were pasted together; zsh reads the whole paste first | Run the command again on its own line |
| `ERR_MODULE_NOT_FOUND: Cannot find package 'openai'` | Dependencies not installed | `npm install` in the project root |
| `402 This request requires more credits, or fewer max_tokens` | Not enough credit for the requested output size | Lower `MAX_TOKENS` in `.env`, or add credit on OpenRouter |
| `Permission denied` when running a skill script | Script isn't executable | `chmod +x path/to/script.sh` (the model usually retries with `bash script.sh`) |
| `agent loop exceeded 20 iterations` | The model kept calling tools without finishing | Make the prompt more specific; raise `MAX_ITERATIONS` for long tasks |
| Model says it can't run commands | The running code doesn't advertise the tool | Check that `app/main.js` is the latest version and saved |
