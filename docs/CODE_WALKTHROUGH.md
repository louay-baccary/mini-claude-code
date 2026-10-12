# Code Walkthrough

How `app/main.js` works, section by section. The whole agent is a single file of about 450 lines with one dependency, the `openai` SDK.

---

## 1. Big picture

A coding agent is a loop:

1. Send the conversation and a list of available tools to the model.
2. If the model answers in plain text, that's the final answer. Stop.
3. If the model asks to call tools, run them, append the results to the conversation, and go back to step 1.

Everything else (skills, slash commands, subagents) is built on top of that loop.

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

---

## 2. Configuration

```js
const MODEL = "anthropic/claude-haiku-4.5";
const MAX_ITERATIONS = 20;
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 4096;
const SKILLS_DIR = join(process.cwd(), ".claude", "skills");
```

- **`MODEL`**: any tool-calling model on OpenRouter works. Haiku is fast and cheap.
- **`MAX_ITERATIONS`**: a safety net so a confused model can't loop forever.
- **`MAX_TOKENS`**: caps output per request. Without it, OpenRouter reserves the model's maximum output, which can exceed a small credit balance.
- **`SKILLS_DIR`**: skills are discovered relative to the directory the agent is launched from, like Claude Code's project-level skills.

The client uses the standard `openai` SDK pointed at OpenRouter's OpenAI-compatible endpoint, so the same code works with any compatible provider by changing `OPENROUTER_BASE_URL`.

---

## 3. Tool definitions

Each tool is a JSON Schema description the model reads to decide when and how to call it:

```js
{
  type: "function",
  function: {
    name: "Read",
    description: "Read and return the contents of a file",
    parameters: { type: "object", properties: { file_path: {...} }, required: ["file_path"] },
  },
}
```

There are two tool sets:

- **`mainTools`** = `Read`, `Write`, `Bash`, `Skill`
- **`subagentTools`** = `Read`, `Write`, `Bash` (no `Skill`, so a forked skill can't spawn more forks)

Descriptions matter. The first version of the Bash description ("Execute a shell command") was vague enough that the model sometimes didn't connect it to "run `ls`". The final description lists example uses.

---

## 4. Tool execution

### `executeTool(ctx, name, rawArgs)`

A single dispatcher:

```js
const args = JSON.parse(rawArgs || "{}");
switch (name) {
  case "Read":  return readFileSync(args.file_path, "utf-8");
  case "Write": mkdirSync(dirname(args.file_path), { recursive: true });
                writeFileSync(args.file_path, args.content, "utf-8");
                return `Successfully wrote to ${args.file_path}`;
  case "Bash":  return runBash(args.command);
  case "Skill": return await runSkill(ctx, args.name, args.args);
}
```

Design choices:

- **Errors are returned, not thrown.** Everything is wrapped in `try/catch`, and failures come back as `"Error: ..."` strings. The model sees the error (for example `ENOENT: no such file`) and can retry with another path, instead of the program crashing.
- **`arguments` arrive as a JSON string**, not an object, so they're parsed first. `|| "{}"` handles models that send empty arguments.
- **`Write` creates parent folders**, so `app/utils/new.py` works even if `utils/` doesn't exist.
- **Every tool returns something.** The API requires a result for every tool call, and an explicit confirmation tells the model the action succeeded.

### `runBash(command)`

```js
spawnSync(command, { shell: true, cwd: process.cwd(), encoding: "utf-8",
                     timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
```

- `spawnSync` with `shell: true` captures stdout, stderr and the exit code in one call, without throwing on a non-zero exit.
- A failing command returns its stderr plus `[exit code N]`, so the model knows it failed.
- An empty output returns `"(command completed with no output)"`. Without it, a successful `rm` returns an empty string, and some models read that as "nothing happened" and retry.
- `timeout` and `maxBuffer` protect against hanging commands (a server waiting forever) and huge outputs.

> Security note: the model gets unrestricted shell access. That's fine in a sandbox. A production agent would ask for confirmation before running commands, as Claude Code does.

---

## 5. The agent loop: `runAgent(ctx, messages, toolset, label)`

```js
for (let i = 0; i < MAX_ITERATIONS; i++) {
  const response = await ctx.client.chat.completions.create({
    model: MODEL, max_tokens: MAX_TOKENS, messages, tools: toolset,
  });

  const message = response.choices[0].message;
  messages.push(message);                       // 1. record the assistant turn

  if (!message.tool_calls?.length) {
    return message.content ?? "";               // 2. no tools → final answer
  }

  for (const toolCall of message.tool_calls) {  // 3. run every requested tool
    const result = await executeTool(ctx, toolCall.function.name, toolCall.function.arguments);
    messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
  }
}
throw new Error("agent loop exceeded MAX_ITERATIONS");
```

Key points:

- **Order matters.** The assistant message containing `tool_calls` must be pushed *before* the `role: "tool"` results. Each tool result references its call by `tool_call_id`, and the API rejects results that don't follow their matching call.
- **All tool calls are handled**, not just the first; the model can request several in one turn.
- **It returns instead of printing**, and throws instead of exiting. That makes the loop reusable: the main conversation and every subagent call the same function with their own `messages` array. Only `main()` prints and exits.
- **`label`** prefixes log lines (`main`, `subagent:oncall`), so stderr shows which loop made which call.

---

## 6. Skills

Skills follow the [Agent Skills](https://agentskills.io) standard: a folder under `.claude/skills/` with a `SKILL.md` file made of YAML frontmatter and a markdown body.

```markdown
---
name: checksum
description: Use this skill when the user asks for the checksum of the data file.
context: fork            # optional
---

Run `scripts/checksum.sh` using the Bash tool.
```

### 6.1 Parsing: `parseFrontmatter` and `parseSimpleYaml`

`parseFrontmatter` splits the file on the `---` markers into `data` (frontmatter) and `body`.

`parseSimpleYaml` is a small hand-written parser that covers what SKILL.md files actually use:

- `key: value` pairs
- quoted strings (`"..."` and `'...'`)
- values that wrap onto indented continuation lines
- block scalars: `|` (keep newlines) and `>` (fold into one line)

This avoids a YAML dependency. For full YAML support, it can be swapped for the `yaml` package in one line.

### 6.2 Discovery: `loadSkills`

Scans `.claude/skills/*/SKILL.md` and builds one object per skill:

```js
{ name, folder, description, context, dir, path, body }
```

- `folder` is the identifier used for invocation, since the standard requires `name` to match the folder name.
- `dir` is stored relative to the project root (`.claude/skills/checksum`), so it matches what `Bash` sees.
- A broken SKILL.md is logged and skipped, so one bad file doesn't take the agent down.

### 6.3 Progressive disclosure

Skills load in three levels, to avoid filling the context window:

| Level | What's loaded | When | Where in the code |
|---|---|---|---|
| 1 | name + description | Always | `buildSystemPrompt` |
| 2 | SKILL.md body | When the skill is used | `renderSkillMessage` (slash command or `Skill` tool) |
| 3 | Bundled scripts and files | When the body tells the model to use them | The model calls `Bash` / `Read` |

`buildSystemPrompt` lists only `- name: description` lines and tells the model to call the `Skill` tool when one matches.

### 6.4 Argument substitution: `substituteArguments`

```js
body.replace(/\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)/g, ...)
```

| Placeholder | Becomes |
|---|---|
| `$ARGUMENTS` | Everything after the skill name, as one string |
| `$ARGUMENTS[n]`, `$n` | The n-th whitespace-separated argument (zero-based) |

- One regex, one pass. The alternation tries `$ARGUMENTS[n]` before `$ARGUMENTS`, so `$ARGUMENTS[1]` is never half-replaced.
- Because it's a single pass, a substituted value that itself contains `$0` isn't substituted again.
- Missing positions become empty strings.

### 6.5 Rendering: `renderSkillMessage` / `renderSubagentPrompt`

A body can reference `scripts/checksum.sh`, but the agent runs from the project root. The rendered message adds a header naming the skill's folder, so the model can join the two paths:

```
Skill: checksum (located at .claude/skills/checksum)
This skill is already loaded. Follow the instructions below directly.
Paths in the instructions below are relative to that folder.

Run `scripts/checksum.sh` using the Bash tool.
```

The "already loaded" line fixed a real bug. When the user invoked `/greet`, the body was already in the conversation, but the system prompt told the model to call the `Skill` tool. The model then called it again (losing the arguments) or narrated its confusion instead of answering.

### 6.6 Slash commands and stacking: `resolvePrompt`

Walks the leading `/name` tokens of the prompt:

```
/greet /shout 7      → expand greet, shout; args "7"
/greet 7 /shout      → expand greet;        args "7 /shout"
/greet /nope 7       → expand greet;        args "/nope 7"   (no such skill)
```

- Expansion stops at the first token that isn't a known skill. That token and everything after become the shared argument text.
- The `(?=\s|$)` lookahead makes the whole token count, so `/greet-x` doesn't half-match `greet`.
- A forked skill can't be stacked: if it appears after another skill it ends the run; if it's first, it runs alone.
- An unknown first command (`/usr/bin/x`, `/typo`) is sent to the model unchanged, with a warning on stderr.

### 6.7 Model-invoked skills: `runSkill`

When the model calls the `Skill` tool:

1. **Look it up** with `findSkill`, by folder name first, then frontmatter name, stripping a leading `/`. Models sometimes pass `"/checksum"` or a display name.
2. **Unknown name**: return an error listing the available skills, so the model can correct itself.
3. **Forked skill** (`context: fork`): run a subagent (next section) and return only its answer.
4. **Already loaded with no new arguments**: return a short "already loaded" note instead of the body again, so a duplicate call with empty args can't override the properly substituted version.
5. **Otherwise**: mark it loaded and return the rendered body as the tool result.

`ctx.loaded` is a `Set` of loaded skill folders, seeded with any slash-invoked skills.

---

## 7. Forked subagents: `runSubagent`

```js
const messages = [{ role: "user", content: renderSubagentPrompt(skill, argString) }];
const answer = await runAgent(ctx, messages, subagentTools, `subagent:${skill.folder}`);
return `Skill ${skill.folder} ran in a separate context and returned: ${answer}`;
```

- **Isolated context.** The subagent's conversation holds only the skill body. No system prompt, no user question, no main-conversation history.
- **Same loop.** It's just `runAgent` with a fresh message list, which is why the loop was refactored to return its answer instead of printing it.
- **Only the answer comes back.** All of the subagent's intermediate tool calls and outputs stay in its own context. The main agent sees a single tool result, which keeps the main context small even when the skill does a lot of work.
- **No recursion.** Subagents get `subagentTools`, which has no `Skill` tool.

For a slash-invoked forked skill (`/oncall`), `main()` runs the subagent first, then hands its answer to the main agent to relay to the user.

---

## 8. Entry point: `main()`

1. Parse `-p "prompt"` and read `OPENROUTER_API_KEY`.
2. `loadSkills()` and build the system prompt (level 1).
3. `resolvePrompt()` to handle slash commands:
   - no skills invoked → the raw prompt becomes the user message
   - forked skill → run the subagent, then pass its answer as the user message
   - inline skills → one user message per expanded body
4. `runAgent()` on the main conversation with `mainTools`.
5. Print the answer to stdout.

`main().catch(...)` prints any error to stderr and exits with code 1.

### stdout vs stderr

Only the final answer goes to **stdout**. Every debug line (`[skills] ...`, `[main tool #1] ...`) goes to **stderr**. That keeps the agent scriptable:

```bash
agent -p "Number of files here? Number only." 2>/dev/null | xargs echo "Count:"
```

---

## 9. Possible extensions

- **Permission prompts** before `Bash` and `Write`, with an allowlist of safe commands
- **Edit tool** for targeted string replacement instead of rewriting whole files
- **Glob / Grep tools** for searching large codebases without shelling out
- **Streaming** responses to show progress in real time
- **Interactive REPL mode** that keeps the conversation across prompts
- **Context management**: summarize or truncate old tool results when the conversation grows
- **`references/` and `assets/`** skill folders (more level 3 disclosure)
