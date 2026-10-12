import OpenAI from "openai";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "fs";
import { dirname, join, relative } from "path";
import { spawnSync } from "child_process";

const MODEL = "anthropic/claude-haiku-4.5";
const MAX_ITERATIONS = 20;
const SKILLS_DIR = join(process.cwd(), ".claude", "skills");

// ---------- Tool definitions ----------

const baseTools = [
  {
    type: "function",
    function: {
      name: "Read",
      description: "Read and return the contents of a file",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The path to the file to read",
          },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Write",
      description: "Write content to a file",
      parameters: {
        type: "object",
        required: ["file_path", "content"],
        properties: {
          file_path: {
            type: "string",
            description: "The path of the file to write to",
          },
          content: {
            type: "string",
            description: "The content to write to the file",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Bash",
      description:
        "Execute a shell command in the project directory and return its stdout/stderr. Use it for ls, rm, mkdir, mv, running scripts, etc.",
      parameters: {
        type: "object",
        required: ["command"],
        properties: {
          command: {
            type: "string",
            description: "The command to execute",
          },
        },
      },
    },
  },
];

const skillTool = {
  type: "function",
  function: {
    name: "Skill",
    description:
      "Load a skill's instructions into the conversation. Only use this for skills whose instructions are not already in the conversation.",
    parameters: {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "The name of the skill to use",
        },
        args: {
          type: "string",
          description: "Optional arguments for the skill",
        },
      },
    },
  },
};

// Main agent gets everything; subagents get no Skill tool, so a forked
// skill can't recursively fork more subagents.
const mainTools = [...baseTools, skillTool];
const subagentTools = baseTools;

// ---------- Frontmatter / YAML ----------

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === '"' && last === '"') {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
    }
    if (first === "'" && last === "'") {
      return value.slice(1, -1).replace(/''/g, "'");
    }
  }
  return value;
}

function parseSimpleYaml(src) {
  const lines = src.split(/\r?\n/);
  const out = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#") || /^\s/.test(line)) {
      i++;
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1];
    const value = match[2].trim();
    i++;

    const block = [];
    while (i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i]))) {
      block.push(lines[i]);
      i++;
    }
    while (block.length && block[block.length - 1].trim() === "") block.pop();

    if (/^[|>][+-]?$/.test(value)) {
      const nonEmpty = block.filter((l) => l.trim());
      const indent = nonEmpty.length
        ? Math.min(...nonEmpty.map((l) => l.match(/^\s*/)[0].length))
        : 0;
      const stripped = block.map((l) => l.slice(indent));
      out[key] =
        value[0] === "|"
          ? stripped.join("\n")
          : stripped.map((l) => l.trim()).filter(Boolean).join(" ");
    } else {
      const parts = [value, ...block.map((l) => l.trim())].filter(Boolean);
      out[key] = unquote(parts.join(" "));
    }
  }

  return out;
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: text };
  return { data: parseSimpleYaml(match[1]), body: match[2] };
}

// ---------- Skills ----------

function loadSkills(dir = SKILLS_DIR) {
  if (!existsSync(dir)) return [];

  const skills = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const skillDir = join(dir, entry.name);
    const skillPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    try {
      const { data, body } = parseFrontmatter(readFileSync(skillPath, "utf-8"));
      skills.push({
        name: data.name || entry.name,
        folder: entry.name,
        description: data.description || "",
        context: String(data.context || "").trim().toLowerCase(),
        dir: relative(process.cwd(), skillDir) || ".",
        path: skillPath,
        body: body.trim(),
      });
    } catch (err) {
      console.error(`[skills] failed to load ${skillPath}: ${err.message}`);
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

const isForked = (skill) => skill.context === "fork";

function findSkill(skills, name) {
  const key = String(name ?? "").trim().replace(/^\//, "");
  return skills.find((s) => s.folder === key) ?? skills.find((s) => s.name === key);
}

function buildSystemPrompt(skills) {
  if (skills.length === 0) return null;
  const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return (
    `You have access to the following skills:\n\n${list}\n\n` +
    `If a skill matches the user's request, call the Skill tool with its name\n` +
    `and follow the instructions it returns.\n\n` +
    `If a skill's instructions are already in the conversation (for example, the user\n` +
    `invoked it with /name), do not call the Skill tool for it. Follow those\n` +
    `instructions directly.`
  );
}

// Replaces $ARGUMENTS[n], $ARGUMENTS and $n in one pass.
// Missing positions become empty strings.
function substituteArguments(body, argString) {
  const args = argString ? argString.split(/\s+/) : [];
  return body.replace(
    /\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)/g,
    (_, bracketIdx, shortIdx) => {
      if (bracketIdx !== undefined) return args[Number(bracketIdx)] ?? "";
      if (shortIdx !== undefined) return args[Number(shortIdx)] ?? "";
      return argString;
    }
  );
}

// Body for the main conversation: header with location + "already loaded".
function renderSkillMessage(skill, argString) {
  const header =
    `Skill: ${skill.folder} (located at ${skill.dir})\n` +
    `This skill is already loaded. Follow the instructions below directly.\n` +
    `Paths in the instructions below are relative to that folder.`;
  return `${header}\n\n${substituteArguments(skill.body, argString)}`;
}

// Prompt for a subagent: the skill's instructions and nothing else from the
// parent conversation. The location line is kept so bundled scripts still resolve.
function renderSubagentPrompt(skill, argString) {
  const header =
    `Skill files are located at ${skill.dir}. ` +
    `Paths in the instructions below are relative to that folder.`;
  return `${header}\n\n${substituteArguments(skill.body, argString)}`;
}

// Expands leading "/skill" tokens.
// - Stops at the first token that isn't a known skill.
// - A forked skill can't be stacked: if it appears after another skill it ends
//   the run (and becomes argument text); if it's first, it's expanded alone.
// Returns { invoked: skill[], argString, rawPrompt }.
function resolvePrompt(prompt, skills) {
  const invoked = [];
  let rest = prompt.trimStart();

  while (true) {
    const match = rest.match(/^\/([A-Za-z0-9_-]+)(?=\s|$)/);
    if (!match) break;

    const skill = skills.find((s) => s.folder === match[1]);
    if (!skill) {
      if (invoked.length === 0) {
        console.error(`[skills] unknown skill "/${match[1]}", sending prompt as-is`);
      }
      break;
    }

    if (isForked(skill) && invoked.length > 0) break;

    invoked.push(skill);
    rest = rest.slice(match[0].length).trimStart();

    if (isForked(skill)) break;
  }

  return { invoked, argString: rest.trim(), rawPrompt: prompt };
}

// ---------- Tool execution ----------

function runBash(command) {
  const result = spawnSync(command, {
    shell: true,
    cwd: process.cwd(),
    encoding: "utf-8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    return `Error: ${result.error.message}`;
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  let output = stdout + (stderr ? (stdout ? "\n" : "") + stderr : "");

  if (result.status !== 0) {
    output += `${output ? "\n" : ""}[exit code ${result.status}]`;
  }

  return output || "(command completed with no output)";
}

async function runSubagent(ctx, skill, argString) {
  const messages = [{ role: "user", content: renderSubagentPrompt(skill, argString) }];
  console.error(`[subagent:${skill.folder}] starting`);
  const answer = await runAgent(ctx, messages, subagentTools, `subagent:${skill.folder}`);
  console.error(`[subagent:${skill.folder}] returned ${JSON.stringify(answer)}`);
  return answer;
}

async function runSkill(ctx, name, args) {
  const skill = findSkill(ctx.skills, name);
  if (!skill) {
    const available = ctx.skills.map((s) => s.folder).join(", ") || "(none)";
    return `Error: unknown skill "${name}". Available skills: ${available}`;
  }

  const argString = String(args ?? "").trim();

  if (isForked(skill)) {
    const answer = await runSubagent(ctx, skill, argString);
    return `Skill ${skill.folder} ran in a separate context and returned: ${answer}`;
  }

  // Don't reload an inline skill that's already in the conversation unless the
  // model passes new arguments; a duplicate with empty args would override the
  // properly substituted version.
  if (ctx.loaded.has(skill.folder) && !argString) {
    console.error(`[skills] ${skill.folder} already loaded, not reloading`);
    return `Skill "${skill.folder}" is already loaded earlier in this conversation. Follow those instructions directly.`;
  }

  ctx.loaded.add(skill.folder);
  console.error(`[skills] model invoked ${skill.folder} args=${JSON.stringify(argString)}`);
  return renderSkillMessage(skill, argString);
}

async function executeTool(ctx, name, rawArgs) {
  try {
    const args = JSON.parse(rawArgs || "{}");
    switch (name) {
      case "Read":
        return readFileSync(args.file_path, "utf-8");
      case "Write":
        mkdirSync(dirname(args.file_path), { recursive: true });
        writeFileSync(args.file_path, args.content, "utf-8");
        return `Successfully wrote to ${args.file_path}`;
      case "Bash":
        return runBash(args.command);
      case "Skill":
        return await runSkill(ctx, args.name, args.args);
      default:
        return `Error: unknown tool "${name}"`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------- Agent loop ----------

// Runs the loop over `messages` until the model answers without tool calls.
// Used for both the main conversation and subagents. Returns the final text.
async function runAgent(ctx, messages, toolset, label = "main") {
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await ctx.client.chat.completions.create({
      model: MODEL,
      messages,
      tools: toolset,
    });

    if (!response.choices || response.choices.length === 0) {
      throw new Error(`[${label}] no choices in response`);
    }

    const message = response.choices[0].message;
    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content ?? "";
    }

    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== "function") continue;

      console.error(
        `[${label} tool #${i + 1}] ${toolCall.function.name} ${toolCall.function.arguments}`
      );

      const result = await executeTool(ctx, toolCall.function.name, toolCall.function.arguments);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  throw new Error(`[${label}] agent loop exceeded ${MAX_ITERATIONS} iterations without a final answer`);
}

// ---------- Main ----------

async function main() {
  const [, , flag, prompt] = process.argv;
  const apiKey = process.env.OPENROUTER_API_KEY;
  const baseURL =
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  if (flag !== "-p" || !prompt) {
    throw new Error("error: -p flag is required");
  }

  const client = new OpenAI({ apiKey, baseURL });

  const skills = loadSkills();
  console.error(
    `[skills] ${skills.map((s) => s.name + (isForked(s) ? " (fork)" : "")).join(", ") || "(none)"}`
  );

  const ctx = { client, skills, loaded: new Set() };

  const messages = [];
  const systemPrompt = buildSystemPrompt(skills);
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  const { invoked, argString, rawPrompt } = resolvePrompt(prompt, skills);

  if (invoked.length === 0) {
    messages.push({ role: "user", content: rawPrompt });
  } else if (isForked(invoked[0])) {
    // Slash-invoked forked skill: run it in a subagent, then let the main
    // agent relay the result.
    const skill = invoked[0];
    console.error(`[skills] invoking /${skill.folder} (fork) args=${JSON.stringify(argString)}`);
    const answer = await runSubagent(ctx, skill, argString);
    messages.push({
      role: "user",
      content:
        `The /${skill.folder} skill ran in a separate context and returned:\n\n${answer}\n\n` +
        `Relay this result to the user.`,
    });
  } else {
    console.error(
      `[skills] invoking ${invoked.map((s) => "/" + s.folder).join(" ")} args=${JSON.stringify(argString)}`
    );
    for (const skill of invoked) {
      ctx.loaded.add(skill.folder);
      messages.push({ role: "user", content: renderSkillMessage(skill, argString) });
    }
  }

  const answer = await runAgent(ctx, messages, mainTools, "main");
  console.log(answer);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});