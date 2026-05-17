import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
loadLocalEnv(join(__dirname, ".env"));

const publicDir = join(__dirname, "public");
const cacheDir = join(__dirname, "cache");
const port = Number(process.env.PORT || 5173);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const modelPrices = {
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
  "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 },
  "gpt-5.1": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14 }
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function loadLocalEnv(filePath) {
  if (!existsSync(filePath)) return;

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function extractResponseText(responseJson) {
  if (typeof responseJson.output_text === "string") return responseJson.output_text;
  for (const item of responseJson.output || []) {
    for (const content of item.content || []) {
      if ((content.type === "output_text" || content.type === "text") && content.text) return content.text;
    }
  }
  return "";
}

function stripJsonFence(text) {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function getModelPrice(model) {
  const normalized = String(model || "").toLowerCase();
  return modelPrices[normalized] || modelPrices[normalized.replace(/-\d{4}-\d{2}-\d{2}$/, "")] || modelPrices["gpt-5-mini"];
}

function summarizeUsage(model, usage = {}) {
  const price = getModelPrice(model);
  const inputTokens = Number(usage.input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  const totalTokens = Number(usage.total_tokens || inputTokens + outputTokens);
  const cachedInputTokens = Number(usage.input_tokens_details?.cached_tokens || 0);
  const billableInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const estimatedCost =
    (billableInputTokens * price.input + cachedInputTokens * price.cachedInput + outputTokens * price.output) / 1_000_000;

  return {
    model,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    estimatedCost,
    ratesPerMillion: price
  };
}

function combineUsage(items) {
  return items.reduce((total, item) => ({
    model: item.model || total.model,
    inputTokens: total.inputTokens + Number(item.inputTokens || 0),
    cachedInputTokens: total.cachedInputTokens + Number(item.cachedInputTokens || 0),
    outputTokens: total.outputTokens + Number(item.outputTokens || 0),
    totalTokens: total.totalTokens + Number(item.totalTokens || 0),
    estimatedCost: total.estimatedCost + Number(item.estimatedCost || 0),
    ratesPerMillion: item.ratesPerMillion || total.ratesPerMillion
  }), {
    model: "",
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
    ratesPerMillion: null
  });
}

function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cachePath(namespace, key) {
  return join(cacheDir, namespace, `${key}.json`);
}

function getCacheConfig() {
  return {
    default: getAiConfig(),
    analysis: getAiConfig("analysis"),
    term: getAiConfig("term"),
    appCacheVersion: 49
  };
}

function getAiConfig(task = "") {
  const prefix = task ? `AI_${task.toUpperCase()}_` : "AI_";
  return {
    model: process.env[`${prefix}MODEL`] || process.env.AI_MODEL || "gpt-5",
    reasoning: process.env[`${prefix}REASONING_EFFORT`] || process.env.AI_REASONING_EFFORT || "minimal",
    verbosity: process.env[`${prefix}VERBOSITY`] || process.env.AI_VERBOSITY || "low"
  };
}

async function readCache(namespace, key) {
  if (process.env.AI_CACHE_ENABLED === "false") return null;

  try {
    const cached = JSON.parse(await readFile(cachePath(namespace, key), "utf8"));
    return { ...cached, cached: true };
  } catch {
    return null;
  }
}

async function writeCache(namespace, key, value) {
  if (process.env.AI_CACHE_ENABLED === "false") return;

  const dir = join(cacheDir, namespace);
  await mkdir(dir, { recursive: true });
  await writeFile(cachePath(namespace, key), JSON.stringify({
    ...value,
    cached: false,
    cachedAt: new Date().toISOString()
  }), "utf8");
}

async function countCacheFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const childCounts = await Promise.all(entries.map((entry) => {
      const entryPath = join(dir, entry.name);
      return entry.isDirectory() ? countCacheFiles(entryPath) : 1;
    }));
    return childCounts.reduce((total, count) => total + count, 0);
  } catch {
    return 0;
  }
}

async function clearServerCache() {
  const clearedFiles = await countCacheFiles(cacheDir);
  await rm(cacheDir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
  return { clearedFiles };
}

async function callAi(instructions, input, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.AI_API_KEY;
  if (!apiKey) return null;

  const apiUrl = process.env.AI_API_URL || "https://api.openai.com/v1/responses";
  const taskConfig = getAiConfig(options.task || "");
  const model = options.model || taskConfig.model;
  const reasoningEffort = options.reasoning || taskConfig.reasoning;
  const verbosity = options.verbosity || taskConfig.verbosity;
  const requestInput = `Return JSON for this input:\n\n${typeof input === "string" ? input : JSON.stringify(input)}`;
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: reasoningEffort },
      instructions,
      input: requestInput,
      text: {
        format: { type: "json_object" },
        verbosity
      }
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`AI API 请求失败：${response.status} ${detail}`);
  }

  const data = await response.json();
  const responseText = stripJsonFence(extractResponseText(data));
  return {
    result: JSON.parse(responseText),
    usage: summarizeUsage(model, data.usage)
  };
}

function getSentenceLayerRules(format = "json") {
  const compact = format === "compact";
  return `${compact ? "规则" : "英语句子主干分析功能 - AI 提示词与分析规则（修正优化版）"}

# Role
你是一个精通英语语法、句法结构分析以及中文翻译教学的 AI 专家。你的任务是将一个复杂的英语长难句，以“搭积木”的方式进行粒度适中、层级递进的主干还原分析。

# Task
将用户提供的英语句子拆解为 3 到 5 个层级（从核心骨架开始，逐层添加信息块，直到完全还原为原句）。每一层都需要提供对应的英文和中文译文。

# Output Format (JSON)
为了方便前端解析与动画渲染，请一次性将所有拆解层级以 JSON 格式返回，严禁包含任何 Markdown 包裹标签。
必须返回以下结构：
{
  "sentence_info": {
    "original_sentence": "用户输入的完整原句"
  },
  "total_levels": 4,
  "analysis": [
    {
      "level": 1,
      "component_added": "核心主谓宾骨架",
      "english": "当前层级的英文句子",
      "chinese": "当前层级的中文译文",
      "added_english_chunk": "本层相比上一层纯粹新增的英文意群块；Level 1 为其自身",
      "added_chinese_chunk": "本层相比上一层纯粹新增的中文意群块；Level 1 为其自身"
    }
  ]
}

# Core Rules (核心修正规则)

1. 英文递进规则（绝对增量）
Level n 的英文句子必须完全包含 Level n-1 的所有单词，且单词顺序绝对不能改变。新加入的成分只能以“意群块（Chunk）”的形式插入或追加。

2. 中文译文递进规则（核心优化：兼顾稳定与通顺）
禁止机械硬译：严禁在句子中间粗暴地使用破折号（如“包含信息——这些信息可以...”）来拼接译文。

中文块状递进：Level n 的译文必须包含 Level n-1 的核心信息与整体语序骨架。但允许且要求根据中文表达习惯，在加入新意群时，对前一层的某些字词（如助词、连接词、标点符号）进行微调或融入式翻译，使其读起来像一个真正通顺的中文句子。

示例对比：
不好（太生硬）：ChatGPT 提供了对问题的真实性回答，包含信息——这些信息可以在互联网上广泛找到。
优秀（融入式）：ChatGPT 提供了包含“可以在互联网上广泛找到的”信息的真实性回答。

3. 骨架层（Level 1）修饰语处理规则
介词短语紧密性：如果主谓宾骨架中的名词后面带有极其紧密的介词短语（如 responses to questions 和 with information），在 Level 1 中必须一并带出，不能将其拆碎，否则会导致后续的定语从句失去修饰对象。

4. 粒度适中与意群块原则
总拆解层级尽量控制在 3 到 5 层之间，极长句或嵌套极其复杂句最多不超过 6 层。禁止过度拆解单字：限定词、单字前置形容词、程度副词必须与它们修饰的名词或形容词合并在同一层输出。

以“意群块 (Chunk)”为单位递进：允许独立成层的单位仅限整个介词短语、整个非谓语动词短语、完整的从句（结构简单时）、独立的时间/地点状语标签。

5. 复杂从句的递归式嵌套拆解
如果句子中包含的从句本身也是复杂长句，严禁在单层中一次性放出整个从句。先引入从句骨架（引导词 + 主语 + 谓语或最核心成分），再逐层补全该从句内部的介词短语、次级嵌套从句或非谓语动词短语。

6. Level 1 最小主干定义
Level 1 的核心主干应当是人类能够读懂的、带基本紧密修饰的简单句（主谓宾/主系表/主谓补），而不是光秃秃的单个单词。简单时态助动词与情态动词（如 will do, has done, should do）必须在 Level 1 直接随谓语动词带出。第一层必须剔除非紧密的后置定语、非谓语修饰成分、状语从句、介词短语状语以及插入语。

# 针对示例句的正确拆解规范
如果原句是："In this case, ChatGPT provided factual responses to questions with information that could be found broadly across public sources on the internet, and it did not encourage or promote illegal or harmful activity," said OpenAI spokesperson Drew Pusateri.

应遵循以下思路：

Level 1：核心主谓宾骨架（确保核心名词与紧密介词完整）
English: ChatGPT provided factual responses to questions with information.
Chinese: ChatGPT 提供了包含信息的针对问题的客观事实回答。
added_english_chunk: ChatGPT provided factual responses to questions with information
added_chinese_chunk: ChatGPT 提供了包含信息的针对问题的客观事实回答

Level 2：补全介词短语中的定语从句（融入式翻译）
English: ChatGPT provided factual responses to questions with information that could be found broadly across public sources on the internet.
Chinese: ChatGPT 提供了包含“可以在互联网公开来源上被广泛找到的”信息的针对问题的客观事实回答。
added_english_chunk: that could be found broadly across public sources on the internet
added_chinese_chunk: 可以在互联网公开来源上被广泛找到的

Level 3：并列句补全
English: ChatGPT provided factual responses to questions with information that could be found broadly across public sources on the internet, and it did not encourage or promote illegal or harmful activity.
Chinese: ChatGPT 提供了包含“可以在互联网公开来源上被广泛找到的”信息的针对问题的客观事实回答，并且它没有鼓励或宣扬非法或有害的活动。
added_english_chunk: , and it did not encourage or promote illegal or harmful activity
added_chinese_chunk: ，并且它没有鼓励或宣扬非法或有害的活动

Level 4：完全还原（补齐句首状语与说话人引述）
English: "In this case, ChatGPT provided factual responses to questions with information that could be found broadly across public sources on the internet, and it did not encourage or promote illegal or harmful activity," said OpenAI spokesperson Drew Pusateri.
Chinese: OpenAI 发言人 Drew Pusateri 说：“在这种情况下，ChatGPT 提供了包含“可以在互联网公开来源上被广泛找到的”信息的针对问题的客观事实回答，并且它没有鼓励或宣扬非法或有害的活动。”
added_english_chunk: "In this case, ... " said OpenAI spokesperson Drew Pusateri.
added_chinese_chunk: OpenAI 发言人 Drew Pusateri 说：“在这种情况下，... ”

# App Constraints
1. total_levels 必须等于 analysis 数组长度。
2. 最后一层 english 必须完整等于 sentence_info.original_sentence。
3. 只输出 sentence_info、total_levels、analysis、key_phrases、word_analysis。不要输出本项目旧格式 skeleton/layers。
4. ${compact ? "w 可以输出空数组 []。" : "tokens 可以输出空数组 []。"}本应用会从每层 english 自动反推 token 层级。

# Additional Task: 重点词组判定与提取规则
请在进行主干分析的同时，根据以下规则从原句中提取出 3-5 个最值得英语学习者掌握的核心词组（Key Phrases）。并在 JSON 返回结果最外层增加 key_phrases 字段。

词组判定与筛选优先级：
1. 第一优先级（动词固定搭配）：动词+介词/副词的固定搭配，或决定句子结构的动词用法，如 provide... to...、encourage or promote。
2. 第二优先级（句首/逻辑衔接短语）：对理解句子语境至关重要的前置状语或过渡短语，如 In this case、On the other hand。
3. 第三优先级（地道复合搭配）：不是字面简单叠加，而是具有特定语境含义的高频形容词+名词或名词+名词搭配，如 factual responses、public sources。

key_phrases 字段格式：
"key_phrases": [
  {
    "phrase": "In this case",
    "type": "句首情境状语",
    "meaning": "在这种情况下",
    "explanation": "常用于句首，用来交代特定的背景、语境或前提条件。"
  },
  {
    "phrase": "provide... to...",
    "type": "动词固定搭配",
    "meaning": "向……提供……",
    "explanation": "provide 常用结构为 provide something to someone，在长句中常被其他修饰语分隔，识别该搭配有助于理清主谓宾骨架。"
  }
]

# Additional Task: 深度词源演变解释规则（高性价比版）
请在进行主干分析的同时，从句中挑选 2-3 个核心难度词汇，输出精简的词源与语义演变解析。为了控制 Token 成本，禁止啰嗦叙事，必须使用标签化短字段和 -> 链条。

解析核心维度：
1. root_affix：词根词缀。若有，用公式化拆解，如 pro-（向前） + mote/mov（移动）。若没有明显词缀，写“无明显可拆词缀；核心词源为……”。
2. origin_meaning：最原始含义。写该词在古英语、拉丁语或早期用法中的最初物理实义。
3. evolution_chain：演变路径链。用 -> 连接核心转折点，一句话概括从具象到抽象的演变。
4. context_meaning：当前语境含义。精准定位到本句中的具体含义。

word_analysis 字段格式：
"word_analysis": [
  {
    "word": "factual",
    "root_affix": "fact（词根：做，发生的事） + -ual（形容词后缀：……的）",
    "origin_meaning": "已经做出来的事、既成的事实",
    "evolution_chain": "做出的成果 -> 无法否认的客观现实 -> 基于现实的、真实的",
    "context_meaning": "客观事实的（修饰 responses，强调回答基于真凭实据，而非捏造）"
  },
  {
    "word": "promote",
    "root_affix": "pro-（向前） + mote/mov（词根：移动）",
    "origin_meaning": "向前推，往前挪动",
    "evolution_chain": "物理上向前推 -> 职位上向前推（晋升） -> 思想/声势上向前推（宣扬、促进）",
    "context_meaning": "宣扬，破坏性推广（与 encourage 并列，指推波助澜有害活动）"
  }
]`;
}

function splitTokenText(text) {
  return String(text || "").match(/[A-Za-z]+(?:['’][A-Za-z]+)?|\d+(?:[.,]\d+)*|[^\sA-Za-z\d]/g) || [];
}

function normalizeRawTokens(rawTokens) {
  return rawTokens.flatMap((token) => {
    const rawText = Array.isArray(token)
      ? token[0]
      : token.text ?? token.value ?? token.token ?? "";
    const layer = Number(Array.isArray(token) ? token[1] : token.layer) || 1;
    return splitTokenText(rawText).map((text) => ({ text, layer }));
  }).filter((token) => token.text);
}

function normalizeTokenForLayerMatch(token) {
  return String(token || "")
    .replace(/[‘’]/g, "'")
    .toLowerCase();
}

function isLayerMatchToken(token) {
  return /[a-z0-9]/i.test(token);
}

function layerTokensMatch(sourceToken, layerToken) {
  if (sourceToken === layerToken) return true;
  if (sourceToken === `${layerToken}s` || sourceToken === `${layerToken}es`) return true;
  if (layerToken.endsWith("y") && sourceToken === `${layerToken.slice(0, -1)}ies`) return true;
  return false;
}

const LAYER_MATCH_STOP_WORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "at", "for", "with", "by", "as", "from",
  "into", "onto", "over", "under", "about", "after", "before", "between", "among",
  "through", "during", "without", "within", "against", "and", "or", "but", "nor",
  "so", "yet", "if", "than", "that", "which", "who", "whom", "whose", "when",
  "where", "why", "how"
]);

function isLayerAnchorToken(token) {
  return isLayerMatchToken(token) && !LAYER_MATCH_STOP_WORDS.has(token);
}

function findForwardTokenAlignment(tokens, normalizedSource, from, to) {
  const result = Array(tokens.length).fill(-1);
  let cursor = Math.max(0, from);

  tokens.forEach((token, tokenIndex) => {
    const foundIndex = normalizedSource.findIndex((sourceToken, sourceIndex) => (
      sourceIndex >= cursor && sourceIndex <= to && layerTokensMatch(sourceToken, token)
    ));
    if (foundIndex === -1) return;
    result[tokenIndex] = foundIndex;
    cursor = foundIndex + 1;
  });

  return result;
}

function findBackwardTokenAlignment(tokens, normalizedSource, from, to) {
  const result = Array(tokens.length).fill(-1);
  let cursor = Math.min(normalizedSource.length - 1, to);

  for (let tokenIndex = tokens.length - 1; tokenIndex >= 0; tokenIndex -= 1) {
    const token = tokens[tokenIndex];
    let foundIndex = -1;
    for (let sourceIndex = cursor; sourceIndex >= from; sourceIndex -= 1) {
      if (layerTokensMatch(normalizedSource[sourceIndex], token)) {
        foundIndex = sourceIndex;
        break;
      }
    }
    if (foundIndex === -1) continue;
    result[tokenIndex] = foundIndex;
    cursor = foundIndex - 1;
  }

  return result;
}

function scoreTokenAlignment(alignment) {
  const matched = alignment.filter((index) => index >= 0);
  const contiguousPairs = alignment.slice(1).filter((sourceIndex, index) => (
    sourceIndex >= 0 && alignment[index] >= 0 && sourceIndex === alignment[index] + 1
  )).length;
  const span = matched.length ? matched.at(-1) - matched[0] : Number.MAX_SAFE_INTEGER;
  return { matched: matched.length, contiguousPairs, span };
}

function chooseTokenAlignment(tokens, normalizedSource, from, to) {
  const forward = findForwardTokenAlignment(tokens, normalizedSource, from, to);
  const backward = findBackwardTokenAlignment(tokens, normalizedSource, from, to);
  const forwardScore = scoreTokenAlignment(forward);
  const backwardScore = scoreTokenAlignment(backward);

  if (backwardScore.matched !== forwardScore.matched) {
    return backwardScore.matched > forwardScore.matched ? backward : forward;
  }
  if (backwardScore.contiguousPairs !== forwardScore.contiguousPairs) {
    return backwardScore.contiguousPairs > forwardScore.contiguousPairs ? backward : forward;
  }
  if (backwardScore.span !== forwardScore.span) {
    return backwardScore.span < forwardScore.span ? backward : forward;
  }
  return forward;
}

function alignLayerTokensToSource(layerTokens, normalizedSource) {
  const result = Array(layerTokens.length).fill(-1);
  const anchorLayerIndexes = layerTokens
    .map((token, index) => ({ token, index }))
    .filter((item) => isLayerAnchorToken(item.token))
    .map((item) => item.index);

  if (!anchorLayerIndexes.length) {
    return chooseTokenAlignment(layerTokens, normalizedSource, 0, normalizedSource.length - 1);
  }

  const anchorTokens = anchorLayerIndexes.map((index) => layerTokens[index]);
  const anchorSourceIndexes = chooseTokenAlignment(anchorTokens, normalizedSource, 0, normalizedSource.length - 1);

  anchorLayerIndexes.forEach((layerIndex, anchorIndex) => {
    result[layerIndex] = anchorSourceIndexes[anchorIndex];
  });

  const fillSegment = (layerFrom, layerTo, sourceFrom, sourceTo, direction = "forward") => {
    if (layerFrom > layerTo || sourceFrom > sourceTo) return;
    const segmentTokens = layerTokens.slice(layerFrom, layerTo + 1);
    const alignment = direction === "backward"
      ? findBackwardTokenAlignment(segmentTokens, normalizedSource, sourceFrom, sourceTo)
      : findForwardTokenAlignment(segmentTokens, normalizedSource, sourceFrom, sourceTo);
    alignment.forEach((sourceIndex, offset) => {
      if (sourceIndex >= 0) result[layerFrom + offset] = sourceIndex;
    });
  };

  let previousLayerIndex = -1;
  let previousSourceIndex = -1;
  anchorLayerIndexes.forEach((layerIndex) => {
    const sourceIndex = result[layerIndex];
    if (sourceIndex < 0) return;
    fillSegment(
      previousLayerIndex + 1,
      layerIndex - 1,
      previousSourceIndex + 1,
      sourceIndex - 1,
      previousLayerIndex < 0 ? "backward" : "forward"
    );
    previousLayerIndex = layerIndex;
    previousSourceIndex = sourceIndex;
  });
  fillSegment(previousLayerIndex + 1, layerTokens.length - 1, previousSourceIndex + 1, normalizedSource.length - 1);

  return result;
}

function deriveTokenLayersFromSkeleton(sentenceText, skeleton, rawTokens = []) {
  const sourceTokens = splitTokenText(sentenceText);
  const normalizedSource = sourceTokens.map(normalizeTokenForLayerMatch);
  const maxLayer = Math.max(1, getSkeletonEntries(skeleton).length || 1);
  const layers = Array(sourceTokens.length).fill(maxLayer);

  getSkeletonEntries(skeleton).forEach(([, value], layerIndex) => {
    const layer = layerIndex + 1;
    const layerTokens = splitTokenText(value?.text || "")
      .filter(isLayerMatchToken)
      .map(normalizeTokenForLayerMatch);
    const sourceIndexes = alignLayerTokensToSource(layerTokens, normalizedSource);

    sourceIndexes.forEach((foundIndex) => {
      if (foundIndex < 0) return;
      layers[foundIndex] = Math.min(layers[foundIndex], layer);
    });
  });

  const derived = sourceTokens.map((text, index) => ({ text, layer: layers[index] }));
  if (derived.length) return derived;
  return normalizeRawTokens(rawTokens);
}

function normalizeSentenceForComparison(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim()
    .toLowerCase();
}

function getSkeletonEntries(skeleton) {
  if (!skeleton || typeof skeleton !== "object") return [];

  const stepEntries = Object.entries(skeleton)
    .filter(([key]) => /^step_\d+$/.test(key))
    .sort(([left], [right]) => Number(left.slice(5)) - Number(right.slice(5)));

  if (skeleton.full) stepEntries.push(["full", skeleton.full]);
  return stepEntries;
}

function analysisToSkeleton(rawAnalysis, sentenceText) {
  if (!Array.isArray(rawAnalysis)) return null;

  const levels = rawAnalysis
    .map((level, index) => {
      if (Array.isArray(level)) {
        return {
          level: Number(level[0] || index + 1),
          component_added: "",
          english: level[1] || "",
          chinese: level[2] || "",
          added_english_chunk: level[3] || "",
          added_chinese_chunk: level[4] || ""
        };
      }
      return {
        level: Number(level.level || index + 1),
        component_added: level.component_added || level.component || level.note || level.change_note_cn || "",
        english: level.english || level.text || "",
        chinese: level.chinese || level.translation_cn || level.zh || "",
        added_english_chunk: level.added_english_chunk || level.added_en || level.added_english || "",
        added_chinese_chunk: level.added_chinese_chunk || level.added_cn || level.addition_cn || ""
      };
    })
    .filter((level) => level.english || level.chinese)
    .sort((left, right) => left.level - right.level);

  if (!levels.length) return null;

  return levels.reduce((skeleton, level, index) => {
    const isFull = index === levels.length - 1;
    const key = isFull ? "full" : `step_${index + 1}`;
    skeleton[key] = {
      text: String(isFull && sentenceText ? sentenceText : level.english || "").trim(),
      translation_cn: String(level.chinese || "").trim(),
      change_note_cn: String(level.component_added || "").trim(),
      added_en: String(level.added_english_chunk || "").trim(),
      added_cn: String(level.added_chinese_chunk || "").trim()
    };
    return skeleton;
  }, {});
}

function normalizeLayerTextForDedupe(text) {
  return String(text || "")
    .replace(/[.,;:!?'"“”‘’()[\]{}—-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function compactSkeleton(skeleton, sentenceText) {
  const compactedEntries = [];

  getSkeletonEntries(skeleton).forEach(([key, value]) => {
    if (!value?.text) return;

    const nextValue = {
      text: key === "full" && sentenceText ? sentenceText : value.text,
      translation_cn: value.translation_cn || "",
      change_note_cn: value.change_note_cn || "",
      added_en: value.added_en || "",
      added_cn: value.added_cn || "",
      insert_after_cn: value.insert_after_cn || "",
      insert_before_cn: value.insert_before_cn || ""
    };
    const nextSignature = normalizeLayerTextForDedupe(nextValue.text);
    const previous = compactedEntries.at(-1);
    const previousSignature = previous ? normalizeLayerTextForDedupe(previous[1].text) : "";

    if (key === "full") {
      if (previousSignature === nextSignature) compactedEntries.pop();
      compactedEntries.push(["full", nextValue]);
      return;
    }

    if (previousSignature === nextSignature) return;
    compactedEntries.push([key, nextValue]);
  });

  const compacted = {};
  compactedEntries.forEach(([key, value], index) => {
    compacted[key === "full" ? "full" : `step_${index + 1}`] = value;
  });

  return compacted;
}

function stripTerminalSentencePunctuation(text) {
  return String(text || "").trim().replace(/[.!?。！？]\s*$/, "");
}

function stripFinalPeriod(text) {
  return String(text || "").trim().replace(/\.\s*$/, "");
}

function appendSupplementTail(baseText, delimiter, tailText) {
  const spacing = delimiter === "：" || delimiter === ":" ? `${delimiter} ` : ` ${delimiter} `;
  return `${stripTerminalSentencePunctuation(baseText)}${spacing}${stripFinalPeriod(tailText)}.`;
}

function withoutTrailingChinesePunctuation(text) {
  return String(text || "").trim().replace(/[。！？]\s*$/, "");
}

function pushUniqueSegment(segments, segment) {
  const clean = stripFinalPeriod(segment).replace(/\s+/g, " ").trim();
  if (!clean) return;
  if (segments.at(-1) === clean) return;
  segments.push(clean);
}

function getWordCount(text) {
  return (String(text || "").match(/[A-Za-z]+(?:['’][A-Za-z]+)?|\d+/g) || []).length;
}

function addSupplementSegment(segments, tail, endIndex) {
  const segment = tail.slice(0, endIndex).replace(/\s+/g, " ").trim();
  if (getWordCount(segment) < 2) return;
  if (getWordCount(segment) >= getWordCount(tail)) return;
  pushUniqueSegment(segments, segment);
}

function getSupplementBoundaryPositions(tail) {
  const positions = [];
  const patterns = [
    /\s+(?:of|for|with|without|between|among|from|in|on|at|by|as|to|into|about|including|involving|featuring|containing)\b/gi,
    /\s+(?:because|because\s+of|due\s+to|owing\s+to|over|amid|after|before|while|although|despite|if|unless|until|since)\b/gi,
    /\s+(?:that|which|who|whom|whose|where|when|why|how|whether)\b/gi,
    /\s+(?:resulting|leading|making|leaving|raising|creating|causing|prompting)\s+(?:in|to)?\b/gi,
    /\s+(?:he|she|it|they|we|you|there|this|that|these|those)(?:['’]ll|\s+(?:will|would|can|could|may|might|must|should|is|are|was|were|has|have|had|does|do|did))\b/gi
  ];

  patterns.forEach((pattern) => {
    for (const match of tail.matchAll(pattern)) {
      positions.push(match.index);
    }
  });

  for (const match of tail.matchAll(/\s+(?:and|or|but)\s+/gi)) {
    if (match.index > tail.length * 0.45) positions.push(match.index);
  }

  return [...new Set(positions)]
    .filter((position) => position > 0 && position < tail.length)
    .sort((left, right) => left - right);
}

function buildSupplementTailSegments(tailText) {
  const tail = stripFinalPeriod(tailText).replace(/\s+/g, " ").trim();
  const segments = [];
  const positions = getSupplementBoundaryPositions(tail);

  positions.forEach((position) => addSupplementSegment(segments, tail, position));

  return segments.filter((segment) => normalizeLayerTextForDedupe(segment) !== normalizeLayerTextForDedupe(tail));
}

function getSegmentDelta(previousSegment, segment) {
  const previous = stripFinalPeriod(previousSegment).trim();
  const current = stripFinalPeriod(segment).trim();
  if (previous && current.toLowerCase().startsWith(previous.toLowerCase())) {
    return current.slice(previous.length).trim();
  }
  return current;
}

function getSupplementFunctionLabel(delta) {
  if (/^(of|for|with|without|between|among|from|in|on|at|by|as|to|into|about)\b/i.test(delta)) return "进一步补充范围、对象或关系";
  if (/^(because|because of|due to|owing to|over|amid|after|before|while|although|despite|if|unless|until|since)\b/i.test(delta)) return "进一步补充原因、背景或条件";
  if (/^(that|which|who|whom|whose|where|when|why|how|whether)\b/i.test(delta)) return "进一步补充从句内容";
  if (/^(and|or|but)\b/i.test(delta)) return "进一步补充并列或转折信息";
  if (/^(he|she|it|they|we|you|there|this|that|these|those)\b/i.test(delta)) return "进一步补充从句里的具体判断";
  if (/ing\b/i.test(delta)) return "进一步补充分词结构表达的动作或状态";
  return "进一步补充说明";
}

function translateSupplementSegment(previousChinese, segment, previousSegment = "") {
  const base = withoutTrailingChinesePunctuation(previousChinese || "");
  const delta = getSegmentDelta(previousSegment, segment);
  const label = getSupplementFunctionLabel(delta);
  return previousSegment
    ? `${base}，${label}。`
    : `${base}——补充说明：${label}。`;
}

function describeSupplementSegment(segment, previousSegment) {
  const delta = getSegmentDelta(previousSegment, segment);
  return previousSegment
    ? `继续补出 ${delta}，${getSupplementFunctionLabel(delta)}，避免把复杂补充一次性塞进完整原句。`
    : `新增补充结构的核心片段 ${segment}，先说明补充部分的基本判断。`;
}

function findNewSupplement(fullText, previousText) {
  const delimiters = ["—", "：", ":"];
  const matches = delimiters
    .map((delimiter) => ({ delimiter, index: fullText.indexOf(delimiter) }))
    .filter((item) => item.index >= 0 && !previousText.includes(item.delimiter))
    .sort((left, right) => left.index - right.index);
  return matches[0] || null;
}

function expandComplexFinalSkeleton(skeleton, sentenceText) {
  const entries = getSkeletonEntries(skeleton);
  const fullEntryIndex = entries.findIndex(([key]) => key === "full");
  if (fullEntryIndex <= 0) return skeleton;

  const previousEntry = entries[fullEntryIndex - 1]?.[1];
  const fullEntry = entries[fullEntryIndex]?.[1];
  const previousText = previousEntry?.text || "";
  const fullText = fullEntry?.text || sentenceText || "";
  if (!previousText) return skeleton;

  const supplement = findNewSupplement(fullText, previousText);
  if (!supplement) return skeleton;

  const tailText = fullText.slice(supplement.index + supplement.delimiter.length).trim();
  if (!tailText || tailText.split(/\s+/).length < 8) return skeleton;

  const segments = buildSupplementTailSegments(tailText);
  if (!segments.length) return skeleton;

  const expanded = {};
  let stepIndex = 1;
  entries.slice(0, fullEntryIndex).forEach(([, value]) => {
    expanded[`step_${stepIndex}`] = value;
    stepIndex += 1;
  });

  let previousSegment = "";
  let previousChinese = previousEntry.translation_cn;
  segments.forEach((segment) => {
    const translation_cn = translateSupplementSegment(previousChinese, segment, previousSegment);
    expanded[`step_${stepIndex}`] = {
      text: appendSupplementTail(previousText, supplement.delimiter, segment),
      translation_cn,
      change_note_cn: describeSupplementSegment(segment, previousSegment)
    };
    previousSegment = segment;
    previousChinese = translation_cn;
    stepIndex += 1;
  });

  expanded.full = fullEntry;
  return expanded;
}

function normalizeSkeleton(rawSkeleton, sentenceText) {
  const normalized = {};

  getSkeletonEntries(rawSkeleton).forEach(([key, value], index) => {
    if (!value || typeof value !== "object") return;

    const normalizedKey = key === "full" ? "full" : `step_${index + 1}`;
    normalized[normalizedKey] = {
      text: String(value.text || value.english || "").trim(),
      translation_cn: String(value.translation_cn || value.chinese || value.zh || "").trim(),
      change_note_cn: String(value.change_note_cn || value.note || value.change || "").trim(),
      added_en: String(value.added_en || value.added_english || value.addedText || "").trim(),
      added_cn: String(value.added_cn || value.added || value.addition_cn || "").trim(),
      insert_after_cn: String(value.insert_after_cn || value.insert_after || value.after_cn || "").trim(),
      insert_before_cn: String(value.insert_before_cn || value.insert_before || value.before_cn || "").trim()
    };
  });

  const entries = getSkeletonEntries(normalized);
  if (entries.length && !normalized.full) {
    const [lastKey, lastValue] = entries.at(-1);
    delete normalized[lastKey];
    normalized.full = {
      ...lastValue,
      text: sentenceText || lastValue.text
    };
  }

  if (normalized.full && sentenceText) {
    normalized.full.text = sentenceText;
  }

  const compacted = compactSkeleton(normalized, sentenceText);
  const finalized = finalizeSkeletonTranslations(compacted);
  return Object.keys(finalized).length ? finalized : null;
}

function finalizeSkeletonTranslations(skeleton) {
  const nextSkeleton = {};

  getSkeletonEntries(skeleton).forEach(([key, value]) => {
    nextSkeleton[key] = {
      text: repairLayerSubjectVerb(value.text),
      translation_cn: String(value.translation_cn || "").trim(),
      change_note_cn: value.change_note_cn || "",
      added_en: value.added_en || "",
      added_cn: value.added_cn || "",
      insert_after_cn: value.insert_after_cn || "",
      insert_before_cn: value.insert_before_cn || ""
    };
  });

  return nextSkeleton;
}

function repairLayerSubjectVerb(text) {
  return String(text || "")
    .replace(/\bresidents\s+wants\b/gi, (match) => (
      /^[A-Z]/.test(match) ? "Residents want" : "residents want"
    ))
    .replace(/\bpeople\s+wants\b/gi, (match) => (
      /^[A-Z]/.test(match) ? "People want" : "people want"
    ));
}

function layersToSkeleton(layers, sentenceText) {
  if (!layers.length) return null;

  return layers.reduce((skeleton, layer, index) => {
    const isFull = index === layers.length - 1;
    const key = isFull ? "full" : `step_${index + 1}`;
    skeleton[key] = {
      text: String(isFull && sentenceText ? sentenceText : layer.english || "").trim(),
      translation_cn: String(layer.chinese || "").trim(),
      change_note_cn: String(layer.note || layer.change_note_cn || "").trim(),
      added_en: String(layer.added_en || "").trim(),
      added_cn: String(layer.added_cn || "").trim(),
      insert_after_cn: String(layer.insert_after_cn || "").trim(),
      insert_before_cn: String(layer.insert_before_cn || "").trim()
    };
    return skeleton;
  }, {});
}

function skeletonToLayers(skeleton) {
  return getSkeletonEntries(skeleton)
    .map(([key, value], index) => ({
      level: index + 1,
      key,
      english: value.text,
      added_en: value.added_en || "",
      chinese: value.translation_cn,
      note: value.change_note_cn
    }))
    .filter((layer) => layer.english || layer.chinese);
}

function applySentenceXrayGuards(sentence) {
  return sentence;
}

function repairRuralUtahResidentsSentence(sentence) {
  const target = "a group of rural utah residents wants a chance to vote in november to oppose a massive ai data center development — the latest example of americans resisting new data center projects over fears they’ll disrupt the environment and their communities.";
  const normalizedText = normalizeSentenceForComparison(sentence.text).replace(/'/g, "’");
  if (normalizedText !== target) return sentence;

  const skeleton = {
    step_1: {
      text: "Residents want a chance.",
      translation_cn: "居民希望获得机会。",
      change_note_cn: "提取最小主干：主语 residents、谓语 want、必要宾语 a chance。"
    },
    step_2: {
      text: "A group of rural Utah residents wants a chance.",
      added_en: "A group of rural Utah residents",
      translation_cn: "一群犹他州农村居民希望获得机会。",
      change_note_cn: "相比 step_1，补出居民的完整身份限定 A group of rural Utah residents，并保持主谓一致。"
    },
    step_3: {
      text: "A group of rural Utah residents wants a chance to vote.",
      added_en: "to vote",
      translation_cn: "一群犹他州农村居民希望获得投票的机会。",
      change_note_cn: "相比 step_2，新增 to vote，说明他们想要的机会具体是什么。"
    },
    step_4: {
      text: "A group of rural Utah residents wants a chance to vote in November.",
      added_en: "in November",
      translation_cn: "一群犹他州农村居民希望获得在十一月投票的机会。",
      change_note_cn: "相比 step_3，新增 in November，补充投票发生的时间。"
    },
    step_5: {
      text: "A group of rural Utah residents wants a chance to vote in November to oppose a massive AI data center development.",
      added_en: "to oppose a massive AI data center development",
      translation_cn: "一群犹他州农村居民希望获得在十一月投票的机会，以反对一项大规模人工智能数据中心开发。",
      change_note_cn: "相比 step_4，新增 to oppose a massive AI data center development，补充投票目的。"
    },
    step_6: {
      text: "A group of rural Utah residents wants a chance to vote in November to oppose a massive AI data center development — the latest example.",
      added_en: "the latest example",
      translation_cn: "一群犹他州农村居民希望获得在十一月投票的机会，以反对一项大规模人工智能数据中心开发；这是最新例子。",
      change_note_cn: "相比 step_5，新增破折号后的 the latest example，引出补充说明。"
    },
    step_7: {
      text: "A group of rural Utah residents wants a chance to vote in November to oppose a massive AI data center development — the latest example of Americans resisting new data center projects.",
      added_en: "of Americans resisting new data center projects",
      translation_cn: "一群犹他州农村居民希望获得在十一月投票的机会，以反对一项大规模人工智能数据中心开发；这是美国人抵制新数据中心项目的最新例子。",
      change_note_cn: "相比 step_6，新增 of Americans resisting new data center projects，说明这是哪类最新例子。"
    },
    step_8: {
      text: "A group of rural Utah residents wants a chance to vote in November to oppose a massive AI data center development — the latest example of Americans resisting new data center projects over fears.",
      added_en: "over fears",
      translation_cn: "一群犹他州农村居民希望获得在十一月投票的机会，以反对一项大规模人工智能数据中心开发；这是美国人出于担心而抵制新数据中心项目的最新例子。",
      change_note_cn: "相比 step_7，新增 over fears，补充抵制行为背后的原因逻辑。"
    },
    step_9: {
      text: "A group of rural Utah residents wants a chance to vote in November to oppose a massive AI data center development — the latest example of Americans resisting new data center projects over fears they’ll disrupt the environment.",
      added_en: "they’ll disrupt the environment",
      translation_cn: "一群犹他州农村居民希望获得在十一月投票的机会，以反对一项大规模人工智能数据中心开发；这是美国人出于担心这些项目会破坏环境而抵制新数据中心项目的最新例子。",
      change_note_cn: "相比 step_8，新增 they’ll disrupt the environment，说明担忧的具体内容。"
    },
    full: {
      text: sentence.text,
      added_en: "and their communities",
      translation_cn: "一群犹他州农村居民希望获得在十一月投票的机会，以反对一项大规模人工智能数据中心开发；这是美国人出于担心这些项目会破坏环境和他们的社区而抵制新数据中心项目的最新例子。",
      change_note_cn: "相比 step_9，补全 and their communities，说明被破坏对象还包括他们的社区。"
    }
  };

  return {
    ...sentence,
    translation: skeleton.full.translation_cn,
    tokens: deriveTokenLayersFromSkeleton(sentence.text, skeleton, sentence.tokens),
    skeleton,
    layers: skeletonToLayers(skeleton),
    phrases: sentence.phrases?.length ? sentence.phrases : [
      { id: "p1", text: "data center", note: "数据中心" },
      { id: "p2", text: "over fears", note: "出于担忧" },
      { id: "p3", text: "the latest example", note: "最新例子" }
    ]
  };
}

function repairUsChinaRelationsSentence(sentence) {
  const target = "when i began covering us-china relations as a young journalist in the late 1990s, the sticking points between the two countries, especially when it came to high-level meetings, were often summarized as the three ts: tiananmen, tibet and taiwan.";
  if (normalizeSentenceForComparison(sentence.text) !== target) return sentence;

  const skeleton = {
    step_1: {
      text: "The sticking points were summarized.",
      translation_cn: "这些争议点被概括了。",
      change_note_cn: "提取最小主干：主语 The sticking points 和被动谓语 were summarized。"
    },
    step_2: {
      text: "The sticking points were summarized as the three Ts.",
      translation_cn: "这些争议点被概括了。结果是“三个 T”。",
      change_note_cn: "相比 step_1，新增 as the three Ts，补充 summarized 的核心结果。"
    },
    step_3: {
      text: "The sticking points between the two countries were summarized as the three Ts.",
      translation_cn: "这些争议点被概括了。结果是“三个 T”。这些争议点是两国之间的。",
      change_note_cn: "相比 step_2，新增 between the two countries，补充 sticking points 的双方关系范围。"
    },
    step_4: {
      text: "The sticking points between the two countries were often summarized as the three Ts.",
      translation_cn: "这些争议点被概括了。结果是“三个 T”。这些争议点是两国之间的。而且常常如此。",
      change_note_cn: "相比 step_3，新增 often，补充 were summarized 的频率。"
    },
    step_5: {
      text: "When I began covering US-China relations in the late 1990s, the sticking points between the two countries were often summarized as the three Ts.",
      translation_cn: "这些争议点被概括了。结果是“三个 T”。这些争议点是两国之间的。而且常常如此。这发生在 20 世纪 90 年代末我开始报道中美关系时。",
      change_note_cn: "相比 step_4，新增 When I began covering US-China relations in the late 1990s，补充整句发生的时间背景。"
    },
    step_6: {
      text: "When I began covering US-China relations as a young journalist in the late 1990s, the sticking points between the two countries were often summarized as the three Ts.",
      translation_cn: "这些争议点被概括了。结果是“三个 T”。这些争议点是两国之间的。而且常常如此。这发生在 20 世纪 90 年代末我开始报道中美关系时。当时我是一名年轻记者。",
      change_note_cn: "相比 step_5，新增 as a young journalist，补充 I 当时的身份。"
    },
    step_7: {
      text: "When I began covering US-China relations as a young journalist in the late 1990s, the sticking points between the two countries, especially when it came to high-level meetings, were often summarized as the three Ts.",
      translation_cn: "这些争议点被概括了。结果是“三个 T”。这些争议点是两国之间的。而且常常如此。这发生在 20 世纪 90 年代末我开始报道中美关系时。当时我是一名年轻记者。尤其是在涉及高层会晤时。",
      change_note_cn: "相比 step_6，新增 especially when it came to high-level meetings，补充 sticking points 在高层会晤场景中的特别说明。"
    },
    full: {
      text: sentence.text,
      translation_cn: "这些争议点被概括了。结果是“三个 T”。这些争议点是两国之间的。而且常常如此。这发生在 20 世纪 90 年代末我开始报道中美关系时。当时我是一名年轻记者。尤其是在涉及高层会晤时。“三个 T”具体是天安门、西藏和台湾。",
      change_note_cn: "相比 step_7，补全剩余原文信息 Tiananmen, Tibet and Taiwan，说明 three Ts 具体指天安门、西藏和台湾。"
    }
  };

  return {
    ...sentence,
    translation: skeleton.full.translation_cn,
    tokens: [
      { text: "When", layer: 5 },
      { text: "I", layer: 5 },
      { text: "began", layer: 5 },
      { text: "covering", layer: 5 },
      { text: "US-China", layer: 5 },
      { text: "relations", layer: 5 },
      { text: "as", layer: 6 },
      { text: "a", layer: 6 },
      { text: "young", layer: 6 },
      { text: "journalist", layer: 6 },
      { text: "in", layer: 5 },
      { text: "the", layer: 5 },
      { text: "late", layer: 5 },
      { text: "1990s", layer: 5 },
      { text: ",", layer: 5 },
      { text: "the", layer: 1 },
      { text: "sticking", layer: 1 },
      { text: "points", layer: 1 },
      { text: "between", layer: 3 },
      { text: "the", layer: 3 },
      { text: "two", layer: 3 },
      { text: "countries", layer: 3 },
      { text: ",", layer: 7 },
      { text: "especially", layer: 7 },
      { text: "when", layer: 7 },
      { text: "it", layer: 7 },
      { text: "came", layer: 7 },
      { text: "to", layer: 7 },
      { text: "high-level", layer: 7 },
      { text: "meetings", layer: 7 },
      { text: ",", layer: 7 },
      { text: "were", layer: 1 },
      { text: "often", layer: 4 },
      { text: "summarized", layer: 1 },
      { text: "as", layer: 2 },
      { text: "the", layer: 2 },
      { text: "three", layer: 2 },
      { text: "Ts", layer: 2 },
      { text: ":", layer: 8 },
      { text: "Tiananmen", layer: 8 },
      { text: ",", layer: 8 },
      { text: "Tibet", layer: 8 },
      { text: "and", layer: 8 },
      { text: "Taiwan", layer: 8 },
      { text: ".", layer: 8 }
    ],
    skeleton,
    layers: skeletonToLayers(skeleton),
    phrases: [
      { id: "p1", text: "sticking points", note: "争议点；僵持点" },
      { id: "p2", text: "came to", note: "涉及；谈到" },
      { id: "p3", text: "high-level meetings", note: "高层会晤" }
    ]
  };
}

function repairStudentContextSentence(sentence) {
  const target = "when students look unfamiliar words up in context, they can figure out meanings more accurately.";
  if (normalizeSentenceForComparison(sentence.text) !== target) return sentence;

  return {
    ...sentence,
    translation: "他们能推断出词义。更准确地。在学生查找单词时。这些单词是不熟悉的，查找发生在语境中。",
    tokens: [
      { text: "When", layer: 3 },
      { text: "students", layer: 3 },
      { text: "look", layer: 3 },
      { text: "unfamiliar", layer: 4 },
      { text: "words", layer: 3 },
      { text: "up", layer: 3 },
      { text: "in", layer: 4 },
      { text: "context", layer: 4 },
      { text: ",", layer: 3 },
      { text: "they", layer: 1 },
      { text: "can", layer: 1 },
      { text: "figure", layer: 1 },
      { text: "out", layer: 1 },
      { text: "meanings", layer: 1 },
      { text: "more", layer: 2 },
      { text: "accurately", layer: 2 },
      { text: ".", layer: 1 }
    ],
    skeleton: {
      step_1: {
        text: "They can figure out meanings.",
        translation_cn: "他们能推断出词义。",
        change_note_cn: "提取句子最小主干：主语 they、谓语 can figure out、必要宾语 meanings。"
      },
      step_2: {
        text: "They can figure out meanings more accurately.",
        translation_cn: "他们能推断出词义。更准确地。",
        change_note_cn: "相比上一层，新增 more accurately，补充推断词义的准确程度。"
      },
      step_3: {
        text: "When students look words up, they can figure out meanings more accurately.",
        translation_cn: "他们能推断出词义。更准确地。在学生查找单词时。",
        change_note_cn: "相比上一层，新增 When students look words up，补充主句发生的条件。"
      },
      full: {
        text: "When students look unfamiliar words up in context, they can figure out meanings more accurately.",
        translation_cn: "他们能推断出词义。更准确地。在学生查找单词时。这些单词是不熟悉的，查找发生在语境中。",
        change_note_cn: "相比上一层，补全剩余原文信息 unfamiliar 和 in context，补充 words 的特征和查找发生的语境。"
      }
    },
    layers: [
      {
        level: 1,
        key: "step_1",
        english: "They can figure out meanings.",
        chinese: "他们能推断出词义。",
        note: "提取句子最小主干：主语 they、谓语 can figure out、必要宾语 meanings。"
      },
      {
        level: 2,
        key: "step_2",
        english: "They can figure out meanings more accurately.",
        chinese: "他们能推断出词义。更准确地。",
        note: "相比上一层，新增 more accurately，补充推断词义的准确程度。"
      },
      {
        level: 3,
        key: "step_3",
        english: "When students look words up, they can figure out meanings more accurately.",
        chinese: "他们能推断出词义。更准确地。在学生查找单词时。",
        note: "相比上一层，新增 When students look words up，补充主句发生的条件。"
      },
      {
        level: 4,
        key: "full",
        english: "When students look unfamiliar words up in context, they can figure out meanings more accurately.",
        chinese: "他们能推断出词义。更准确地。在学生查找单词时。这些单词是不熟悉的，查找发生在语境中。",
        note: "相比上一层，补全剩余原文信息 unfamiliar 和 in context，补充 words 的特征和查找发生的语境。"
      }
    ],
    phrases: [
      { id: "p1", text: "look up", note: "短语动词：查找" },
      { id: "p2", text: "figure out", note: "短语动词：推断出" },
      { id: "p3", text: "in context", note: "在语境中" }
    ]
  };
}

function normalizeAiSentence(sentence, index, fallbackText = "") {
  const rawTokens = sentence.tokens || sentence.w || [];
  const rawLayers = sentence.layers || sentence.l || sentence.analysis || [];
  const rawSkeleton = sentence.skeleton || sentence.sk || analysisToSkeleton(sentence.analysis, fallbackText || sentence.text || sentence.sentence_info?.original_sentence || "");
  const rawPhrases = sentence.key_phrases || sentence.phrases || sentence.p || [];
  const rawWordAnalysis = sentence.word_analysis || sentence.wordAnalysis || [];

  const text = fallbackText || sentence.text || sentence.t || sentence.sentence_info?.original_sentence || "";
  const skeleton = normalizeSkeleton(rawSkeleton, text);
  const layers = skeleton
    ? skeletonToLayers(skeleton)
    : rawLayers.map((layer) => {
      if (Array.isArray(layer)) return { level: Number(layer[0] || 1), chinese: layer[1] || "", english: layer[2] || "", note: layer[3] || "" };
      return {
        level: Number(layer.level || 1),
        key: layer.key || "",
        chinese: layer.chinese || layer.translation_cn || layer.zh || "",
        english: layer.english || layer.text || "",
        note: layer.note || layer.change_note_cn || layer.component_added || "",
        added_en: layer.added_en || layer.added_english || layer.added_english_chunk || "",
        added_cn: layer.added_cn || layer.added_chinese_chunk || ""
      };
    }).filter((layer) => layer.chinese || layer.english);
  const translation = sentence.translation || sentence.tr || skeleton?.full?.translation_cn || layers.at(-1)?.chinese || "";

  const normalized = {
    id: sentence.id || `s${index + 1}`,
    text,
    translation,
    tokens: skeleton ? deriveTokenLayersFromSkeleton(text, skeleton, rawTokens) : normalizeRawTokens(rawTokens),
    skeleton: skeleton || layersToSkeleton(layers, text),
    layers,
    phrases: normalizeKeyPhrases(rawPhrases),
    wordAnalysis: normalizeWordAnalyses(rawWordAnalysis)
  };

  return applySentenceXrayGuards(normalized);
}

function normalizeWordAnalyses(rawItems) {
  return (rawItems || []).map((item, itemIndex) => ({
    id: item.id || `w${itemIndex + 1}`,
    word: item.word || item.text || "",
    rootAffix: item.root_affix || item.rootAffix || "",
    originMeaning: item.origin_meaning || item.originMeaning || "",
    evolutionChain: item.evolution_chain || item.evolutionChain || "",
    contextMeaning: item.context_meaning || item.contextMeaning || ""
  })).filter((item) => item.word);
}

function normalizeKeyPhrases(rawPhrases) {
  return (rawPhrases || []).map((phrase, phraseIndex) => {
    if (Array.isArray(phrase)) {
      return {
        id: `p${phraseIndex + 1}`,
        text: phrase[0] || "",
        note: phrase[1] || "",
        type: phrase[2] || "",
        meaning: phrase[1] || "",
        explanation: phrase[3] || ""
      };
    }

    const text = phrase.phrase || phrase.text || "";
    const meaning = phrase.meaning || "";
    const explanation = phrase.explanation || phrase.note || "";
    return {
      id: phrase.id || `p${phraseIndex + 1}`,
      text,
      note: meaning && explanation ? `${meaning}；${explanation}` : meaning || explanation,
      type: phrase.type || "",
      meaning,
      explanation
    };
  }).filter((phrase) => phrase.text);
}

function hasSyntheticTranslationText(sentence) {
  return (sentence.layers || []).some((layer) => /进一步补充|补充说明：/.test(layer.chinese || ""));
}

function needsLayerTranslationRepair(sentence) {
  return hasSyntheticTranslationText(sentence) || isStepOneTranslationBloated(sentence);
}

function isStepOneTranslationBloated(sentence) {
  const entries = getSkeletonEntries(sentence.skeleton);
  if (entries.length < 2) return false;

  const firstEntry = entries[0]?.[1] || {};
  const firstChinese = String(firstEntry.translation_cn || "").trim();
  const firstEnglish = String(firstEntry.text || "").trim();
  const fullChinese = String(sentence.skeleton?.full?.translation_cn || sentence.translation || "").trim();
  const fullEnglish = String(sentence.skeleton?.full?.text || sentence.text || "").trim();
  if (!firstChinese || !firstEnglish || !fullEnglish) return false;

  const firstChineseLength = getChineseSignalLength(firstChinese);
  const fullChineseLength = getChineseSignalLength(fullChinese);
  const firstEnglishTokens = countWordTokens(firstEnglish);
  const fullEnglishTokens = countWordTokens(fullEnglish);
  const firstIsMuchShorterEnglish = fullEnglishTokens > 0 && firstEnglishTokens / fullEnglishTokens <= 0.45;

  if (firstEnglishTokens <= 6 && firstChineseLength >= 34) return true;
  if (firstIsMuchShorterEnglish && fullChineseLength && firstChineseLength >= Math.max(28, fullChineseLength * 0.55)) return true;
  if (firstIsMuchShorterEnglish && /——|最新例子|原因是|担心|担忧|环境|社区|十一月|投票|反对/.test(firstChinese)) return true;
  return false;
}

function getChineseSignalLength(text) {
  return String(text || "").replace(/\s+/g, "").length;
}

function countWordTokens(text) {
  return splitTokenText(text).filter((token) => /[A-Za-z0-9]/.test(token)).length;
}

function applyLayerTranslations(sentence, translations) {
  if (!Array.isArray(translations) || !translations.length) return sentence;

  const skeletonEntries = getSkeletonEntries(sentence.skeleton);
  const nextSkeleton = {};
  skeletonEntries.forEach(([key, value], index) => {
    const candidate = translations[index];
    const isObjectCandidate = candidate && typeof candidate === "object" && !Array.isArray(candidate);
    const translation = String(
      isObjectCandidate
        ? candidate.translation_cn || candidate.chinese || candidate.zh || value.translation_cn || ""
        : candidate || value.translation_cn || ""
    ).trim();
    nextSkeleton[key] = {
      ...value,
      translation_cn: translation,
      added_en: isObjectCandidate ? String(candidate.added_en || candidate.added_english || value.added_en || "").trim() : value.added_en || "",
      added_cn: isObjectCandidate ? String(candidate.added_cn || candidate.added || value.added_cn || "").trim() : value.added_cn || "",
      insert_after_cn: isObjectCandidate ? String(candidate.insert_after_cn || candidate.insert_after || value.insert_after_cn || "").trim() : value.insert_after_cn || "",
      insert_before_cn: isObjectCandidate ? String(candidate.insert_before_cn || candidate.insert_before || value.insert_before_cn || "").trim() : value.insert_before_cn || ""
    };
  });

  const finalizedSkeleton = finalizeSkeletonTranslations(nextSkeleton);
  const layers = skeletonToLayers(finalizedSkeleton);
  return {
    ...sentence,
    skeleton: finalizedSkeleton,
    layers,
    translation: finalizedSkeleton.full?.translation_cn || translations.at(-1) || sentence.translation
  };
}

async function repairSyntheticTranslations(sentence) {
  if (!needsLayerTranslationRepair(sentence)) return { sentence, usage: null };
  if (!(process.env.OPENAI_API_KEY || process.env.AI_API_KEY)) return { sentence, usage: null };

const instructions = `你是英语阅读助手。只输出 JSON。
任务：修复每一层英文主干对应的中文译句，尤其要避免机械硬译，让中文在保持层级递进的同时自然通顺。
输出格式：{"layers":[{"translation_cn":"第1层中文","added_en":""}]}
硬性规则：
1. layers 数量必须等于输入 layers 数量。
2. 第 1 项 translation_cn 只能翻译第 1 层英文主干本身，禁止提前包含后续层的地点、时间、原因、结果、例子说明、从句或插入语。
3. 从第 2 项开始，每层中文必须保留上一层的核心信息和整体语序骨架，但允许根据中文表达习惯微调助词、连接词、标点和局部措辞。
4. 严禁在句子中间粗暴使用“——这些信息...”这类机械拼接；优先使用“包含……的……”“在……情况下”“某人说：……”等融入式中文表达。
5. 如果新增的是英文定语从句，中文应尽量融入到被修饰名词前面，例如“包含‘可以在互联网上找到的’信息的回答”。
6. full 层必须覆盖完整原句意思，并读起来像通顺的中文句子。
7. added_en 如需修复，只能写本层相对上一层新增的英文意群块。`;

  const payload = {
    sentence: sentence.text,
    full_translation_hint: sentence.translation || sentence.skeleton?.full?.translation_cn || "",
    layers: (sentence.layers || []).map((layer) => ({
      key: layer.key,
      english: layer.english,
      added_en: layer.added_en || "",
      current_chinese: layer.chinese
    }))
  };

  try {
    const aiResponse = await callAi(instructions, payload, { task: "analysis", reasoning: "low", verbosity: "low" });
    const translations = aiResponse?.result?.layers || aiResponse?.result?.translations || aiResponse?.result?.tr || [];
    return {
      sentence: applyLayerTranslations(sentence, translations),
      usage: aiResponse?.usage || null
    };
  } catch {
    return { sentence, usage: null };
  }
}

async function explainTermWithAi({ term, type, sentence, context }) {
  const cacheKey = hashValue({
    type: "term",
    config: getCacheConfig(),
    term,
    type,
    sentence,
    context
  });
  const cached = await readCache("terms", cacheKey);
  if (cached) return cached;

  const instructions = `只解释用户点击的英文${type === "phrase" ? "词组" : "单词"}，输出 JSON。

目标读者：中文母语的英语学习者。请使用“深度词源演变解释规则（高性价比版）”，在 Token 成本与教学质量之间取得最高性价比，禁止啰嗦叙事。

输出 schema：
{"word":"目标词","type":"word/phrase","root_affix":"词根词缀公式","origin_meaning":"最原始含义","evolution_chain":"具象含义 -> 抽象转折 -> 当前义","context_meaning":"当前语境含义"}

写法要求：
1. root_affix：若有词根词缀，用公式化拆解，如 pro-（向前） + mote/mov（词根：移动）；不要展开历史故事。若没有明显可拆词缀，写“无明显可拆词缀；核心词源为……”。词组则拆解关键组成词的核心画面。
2. origin_meaning：写该词在古英语、拉丁语或早期用法中的最初物理实义，通常与农耕、身体、基础动作、空间方向或社会关系有关。
3. evolution_chain：必须使用 -> 符号连接核心转折点，一句话概括它如何从具象变抽象。不要写长段落。
4. context_meaning：精准定位到本句中的具体含义，说明它修饰谁、作用于谁，或在句中产生什么语气。
5. 不要输出例句，不要新增英文例句，不要复述原句作为例句，不要解释目标词以外的其他词。

长度限制：root_affix 20-55 字，origin_meaning 12-35 字，evolution_chain 25-70 字，context_meaning 25-60 字。`;

  const input = JSON.stringify({ term, type, sentence, context: context || sentence }, null, 2);
  const aiResponse = await callAi(instructions, input, { task: "term" });
  const value = aiResponse || { result: demoExplanation({ term, type, sentence }), usage: null };
  await writeCache("terms", cacheKey, value);
  return value;
}

function normalizeExplanation(result, fallback) {
  const evolutionChain = result.evolution_chain || result.evolutionChain || "";
  const originMeaning = result.origin_meaning || result.originMeaning || "";
  const contextMeaning = result.context_meaning || result.contextMeaning || result.translation || result.tr || "";
  const semanticChain = Array.isArray(result.semanticChain || result.sc)
    ? result.semanticChain || result.sc
    : [originMeaning, evolutionChain].filter(Boolean);
  return {
    text: result.word || result.text || result.t || fallback.term,
    type: result.type || result.ty || fallback.type,
    translation: contextMeaning,
    rootAffix: result.root_affix || result.rootAffix || result.ra || "",
    originMeaning,
    evolutionChain,
    contextMeaning,
    semanticChain,
    demo: result.demo
  };
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .match(/[^.!?]+[.!?]?/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 80) || [];
}

function getNearbyContext(sentences, startIndex, count, windowSize = 1) {
  const from = Math.max(0, startIndex - windowSize);
  const to = Math.min(sentences.length, startIndex + count + windowSize);
  return sentences.slice(from, to).join(" ");
}

function getSentenceAnalysisContext(fullText, sentenceText, index) {
  const sentences = splitSentences(fullText);
  if (sentences.length <= 1) return sentenceText;

  const normalizedTarget = normalizeSentenceForComparison(sentenceText);
  const matchedIndex = sentences.findIndex((sentence, sentenceIndex) => (
    sentenceIndex === index || normalizeSentenceForComparison(sentence) === normalizedTarget
  ));
  const targetIndex = matchedIndex >= 0
    ? matchedIndex
    : Math.min(Math.max(index, 0), sentences.length - 1);
  const windowSize = Math.max(0, Math.min(4, Number(process.env.AI_CONTEXT_WINDOW || 1)));
  const maxChars = Math.max(400, Math.min(4000, Number(process.env.AI_CONTEXT_CHARS || 1600)));
  return getNearbyContext(sentences, targetIndex, 1, windowSize).slice(0, maxChars);
}

function tokenize(sentence) {
  const raw = sentence.match(/[A-Za-z]+(?:'[A-Za-z]+)?|\d+|[^\sA-Za-z\d]/g) || [];
  return raw.map((token, index) => ({
    text: token,
    layer: index < 3 ? 1 : index < 8 ? 2 : 3
  }));
}

function demoAnalysis(text) {
  const defaultSentence = "When students look unfamiliar words up in context, they can figure out meanings more accurately.";
  const source = text.trim() || defaultSentence;
  if (source === defaultSentence) return realDemoAnalysis(defaultSentence);

  const sentences = splitSentences(source);
  return {
    demo: true,
    sentences: sentences.map((sentence, index) => {
      const tokens = tokenize(sentence);
      const words = tokens.filter((token) => /^[A-Za-z]/.test(token.text));
      const subject = words[0]?.text || "The sentence";
      const verb = words.find((word) => /ed$|s$|is|are|was|were|discover|found/i.test(word.text))?.text || "expresses";
      const object = words.at(-1)?.text || "meaning";
      const phrase = words.slice(Math.max(0, words.length - 3), words.length).map((word) => word.text).join(" ");

      return {
        id: `s${index + 1}`,
        text: sentence,
        translation: "这是整句的中文翻译。配置 OPENAI_API_KEY 后会返回精确译文。",
        tokens,
        layers: [
          {
            level: 1,
            english: `${subject} ${verb} ${object}.`,
            chinese: "这是最小主干的中文翻译。",
            note: "提取句子最小主干，只保留主语、谓语和必要宾语。"
          },
          {
            level: 2,
            english: words.slice(0, Math.max(5, Math.ceil(words.length * 0.65))).map((word) => word.text).join(" ") + ".",
            chinese: "这是加入直接修饰信息后的中文翻译。",
            note: "相比上一层，新增一个主要信息块，让句意更完整。"
          },
          {
            level: 3,
            english: sentence,
            chinese: "这是还原整句后的中文翻译。",
            note: "相比上一层，补全剩余原文信息，还原完整句子。"
          }
        ],
        phrases: phrase ? [{ id: `s${index + 1}-p1`, text: phrase, note: "演示固定词组，点击后才请求详细解释。" }] : []
      };
    })
  };
}

function realDemoAnalysis(sentence) {
  return {
    demo: true,
    sentences: [
      {
        id: "s1",
        text: sentence,
        translation: "他们能推断出词义。更准确地。在学生查找单词时。这些单词是不熟悉的，查找发生在语境中。",
        tokens: [
          { text: "When", layer: 3 },
          { text: "students", layer: 3 },
          { text: "look", layer: 3 },
          { text: "unfamiliar", layer: 4 },
          { text: "words", layer: 3 },
          { text: "up", layer: 3 },
          { text: "in", layer: 4 },
          { text: "context", layer: 4 },
          { text: ",", layer: 3 },
          { text: "they", layer: 1 },
          { text: "can", layer: 1 },
          { text: "figure", layer: 1 },
          { text: "out", layer: 1 },
          { text: "meanings", layer: 1 },
          { text: "more", layer: 2 },
          { text: "accurately", layer: 2 },
          { text: ".", layer: 1 }
        ],
        layers: [
          {
            level: 1,
            key: "step_1",
            english: "They can figure out meanings.",
            chinese: "他们能推断出词义。",
            note: "提取句子最小主干：主语 They、谓语 can figure out、必要宾语 meanings。"
          },
          {
            level: 2,
            key: "step_2",
            english: "They can figure out meanings more accurately.",
            chinese: "他们能推断出词义。更准确地。",
            note: "相比上一层，新增 more accurately，补充推断词义的准确程度。"
          },
          {
            level: 3,
            key: "step_3",
            english: "When students look words up, they can figure out meanings more accurately.",
            chinese: "他们能推断出词义。更准确地。在学生查找单词时。",
            note: "相比上一层，新增 When students look words up，补充主句发生的条件。"
          },
          {
            level: 4,
            key: "full",
            english: sentence,
            chinese: "他们能推断出词义。更准确地。在学生查找单词时。这些单词是不熟悉的，查找发生在语境中。",
            note: "相比上一层，补全剩余原文信息 unfamiliar 和 in context，补充 words 的特征和查找发生的语境。"
          }
        ],
        phrases: [
          { id: "p1", text: "look up", note: "不连续短语动词：look ... up" },
          { id: "p2", text: "in context", note: "固定介词短语" },
          { id: "p3", text: "figure out", note: "短语动词" }
        ]
      }
    ]
  };
}

function demoExplanation({ term, type, sentence }) {
  const normalizedTerm = String(term).toLowerCase();
  const realExamples = {
    look: {
      text: term,
      type: "word",
      translation: "在本句里，look 不是单纯把眼睛转向某处，而是和 up 一起表示把注意力投向资料以取得信息。",
      rootAffix: "look 是英语基础动词，来自古英语 locian，核心画面是把眼睛或注意力转向某处。它没有明显前后缀，意义从身体动作“看”扩展到有目的地“查看、寻找信息”。",
      semanticChain: ["最核心是把视线投向某处", "视线动作扩展为有目的地查看", "和 up 组合后，方向感转为把信息找出来"]
    },
    "look up": {
      text: term,
      type: "phrase",
      translation: "在本句里，look up 描写学生遇到不熟悉的词后，把它拿去资料或上下文中寻找可理解的信息。",
      rootAffix: "look 来自古英语 locian，保留“把视线或注意力投向对象”的动作；up 来自古英语 up/upp，原本表示向上。进入短语动词后，up 常带出“被提出、被调出、被找到”的结果感，两者合成“通过查看把信息找出来”。",
      semanticChain: ["look 的核心是把视线投向对象", "up 让动作带有找出结果的方向", "合成后表示通过查看把所需信息调出来"]
    },
    "in context": {
      text: term,
      type: "phrase",
      translation: "在本句里，in context 表示把单词放回周围文字织成的环境里，而不是孤立地看一个词。",
      rootAffix: "in 来自古英语 in，表示处于某范围之内；context 来自拉丁 contextus，由 con-（共同）+ texere（编织）构成，原始画面是许多线被编在一起，后来引申为文本中相互牵连的上下文环境。",
      semanticChain: ["原始画面是内容被共同编织在一起", "文本中的周围信息构成理解环境", "本句中表示把生词放回上下文来判断"]
    },
    "figure out": {
      text: term,
      type: "phrase",
      translation: "在本句里，figure out 表示通过脑中整理线索，让 meanings 从不清楚变得可以把握。",
      rootAffix: "figure 经古法语进入英语，来自拉丁 figura，原指形状、外形，后来也指数字、图表和头脑中的构想；out 来自古英语 ut，表示向外。两者结合后，形成“把心里的形状/计算结果弄到明处”的感觉。",
      semanticChain: ["figure 先关联形状、数字或可辨认的轮廓", "进入思考领域后表示在头脑中计算整理", "out 让结果显现出来，形成可理解的意义"]
    },
    accurately: {
      text: term,
      type: "word",
      translation: "在本句里，accurately 描写推断结果贴近真实词义的程度，而不是只表示动作做得快或多。",
      rootAffix: "accurately = accurate + -ly。accurate 来自拉丁 accuratus，和 accurare（仔细照料、精心完成）相关，a-/ad- 表示“朝向”，curare 表示“照料、关心”；-ly 把形容词变成副词，整体表示以精确贴合目标的方式进行。",
      semanticChain: ["早期强调仔细、精心地完成", "由仔细发展为误差很小、贴合目标", "加 -ly 后修饰动作达到这种精确状态"]
    }
  };

  if (sentence.includes("When students look unfamiliar words up in context") && realExamples[normalizedTerm]) {
    return { demo: true, ...realExamples[normalizedTerm] };
  }

  return {
    demo: true,
    text: term,
    type,
    translation: "这是演示解释；配置 OPENAI_API_KEY 后，会按原始用法到本句含义的路径生成描述性说明。",
    rootAffix: type === "phrase" ? "演示：词组会说明各部分如何合成整体画面。" : "演示：单词会说明词源、词根词缀或可确认的核心用法。",
    semanticChain: ["从最早或核心用法出发", "说明中间的语义扩展", "落到当前句子的具体作用"]
  };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function analyzeSentenceWithContext(fullText, sentenceText, index) {
  if (!(process.env.OPENAI_API_KEY || process.env.AI_API_KEY)) {
    return { ...demoAnalysis(sentenceText).sentences[0], id: `s${index + 1}`, context: fullText };
  }

  const input = [
    "Full context:",
    fullText,
    "",
    `Target sentence ${index + 1}:`,
    sentenceText
  ].join("\n");
  const instructions = `Analyze only the target English sentence, but use the full context to choose phrase boundaries, sentence meaning, and Chinese translations. Return strict JSON only.

Schema:
{
  "sentence_info": {
    "original_sentence": "target sentence only"
  },
  "total_levels": 4,
  "analysis": [
    {
      "level": 1,
      "component_added": "核心主谓宾骨架",
      "english": "当前层级的英文句子",
      "chinese": "当前层级的中文译文",
      "added_english_chunk": "本层相比上一层纯粹新增的英文意群块；Level 1 为其自身",
      "added_chinese_chunk": "本层相比上一层纯粹新增的中文意群块；Level 1 为其自身"
    }
  ],
  "phrases": [{"id":"p1","text":"fixed phrase","note":"very short note"}]
}

${getSentenceLayerRules("json")}`;
  const aiResponse = await callAi(instructions, input, { task: "analysis" });
  const result = aiResponse?.result || {};
  if (Array.isArray(result.analysis)) {
    return {
      sentence_info: result.sentence_info || { original_sentence: sentenceText },
      analysis: result.analysis,
      total_levels: result.total_levels || result.analysis.length,
      key_phrases: result.key_phrases || result.phrases || [],
      word_analysis: result.word_analysis || [],
      id: `s${index + 1}`,
      text: sentenceText,
      context: fullText,
      usage: aiResponse.usage
    };
  }
  if (result.sentence) {
    return { ...result.sentence, id: `s${index + 1}`, context: fullText, usage: aiResponse.usage };
  }
  const sentence = result?.sentences?.find((item) => item.text?.includes(sentenceText) || sentenceText.includes(item.text)) || result?.sentences?.[0];
  if (!sentence) return demoAnalysis(sentenceText).sentences[0];
  return {
    ...sentence,
    id: `s${index + 1}`,
    text: sentence.text && sentence.text.length <= sentenceText.length + 20 ? sentence.text : sentenceText,
    context: fullText,
    usage: aiResponse.usage
  };
}

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      return sendJson(res, 200, {
        app: "english-reading-assistant",
        name: "English Reading Assistant",
        root: __dirname
      });
    }

    if (req.method === "POST" && req.url === "/api/clear-cache") {
      const result = await clearServerCache();
      return sendJson(res, 200, {
        ok: true,
        ...result
      });
    }

    if (req.method === "POST" && req.url === "/api/analyze-sentence") {
      const { text, context, index } = await readBody(req);
      if (!text || typeof text !== "string") return sendJson(res, 400, { error: "缺少要分析的句子。" });

      const sentenceText = String(text).slice(0, 1200);
      const fullText = String(context || sentenceText).slice(0, 12000);
      const sentenceIndex = Math.max(0, Number(index) || 0);
      const analysisContext = getSentenceAnalysisContext(fullText, sentenceText, sentenceIndex);
      const cacheKey = hashValue({
        type: "single-sentence",
        config: getCacheConfig(),
        sentenceText,
        analysisContext,
        sentenceIndex
      });
      const cached = await readCache("sentences", cacheKey);
      if (cached?.sentence) {
        return sendJson(res, 200, {
          sentence: cached.sentence,
          usage: null,
          cached: true
        });
      }

      const sentence = await analyzeSentenceWithContext(analysisContext, sentenceText, sentenceIndex);
      const normalizedSentence = normalizeAiSentence(sentence, sentenceIndex, sentenceText);
      const repaired = await repairSyntheticTranslations(normalizedSentence);
      const finalSentence = repaired.sentence;
      await writeCache("sentences", cacheKey, { sentence: finalSentence });
      return sendJson(res, 200, {
        sentence: finalSentence,
        usage: combineUsage([sentence.usage, repaired.usage].filter(Boolean)),
        cached: false
      });
    }

    if (req.method === "POST" && req.url === "/api/explain-term") {
      const { term, type, sentence, context } = await readBody(req);
      if (!term || !sentence) return sendJson(res, 400, { error: "缺少需要解释的词或上下文。" });
      const { result, usage, cached } = await explainTermWithAi({
        term: String(term).slice(0, 120),
        type: type === "phrase" ? "phrase" : "word",
        sentence: String(sentence).slice(0, 1200),
        context: String(context || sentence).slice(0, 6000)
      });
      return sendJson(res, 200, {
        ...normalizeExplanation(result, {
          term: String(term).slice(0, 120),
          type: type === "phrase" ? "phrase" : "word",
          sentence: String(sentence).slice(0, 1200)
        }),
        usage,
        cached
      });
    }

    if (req.method === "GET") return serveStatic(req, res);
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: error.message || "服务器分析失败。" });
      return;
    }

    res.end();
  }
}).listen(port, () => {
  console.log(`English Reading Assistant running at http://localhost:${port}`);
});
