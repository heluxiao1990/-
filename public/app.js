const state = {
  analysis: null,
  visibleLayer: "all",
  selectedItem: null,
  explanationCache: new Map(),
  reviewQueue: [],
  reviewIndex: 0,
  reviewFlipped: false,
  drawerOffset: { x: 0, y: 0 },
  drawerDrag: null,
  sourceContext: "",
  activeSentenceIndex: null,
  paragraphBreaks: [],
  usage: null,
  book: loadBook()
};

const SENTENCE_CACHE_VERSION = 41;

const elements = {
  sourceText: document.querySelector("#sourceText"),
  articleText: document.querySelector("#articleText"),
  appendArticleBtn: document.querySelector("#appendArticleBtn"),
  joinArticleBtn: document.querySelector("#joinArticleBtn"),
  replaceArticleBtn: document.querySelector("#replaceArticleBtn"),
  clearArticleBtn: document.querySelector("#clearArticleBtn"),
  analyzeBtn: document.querySelector("#analyzeBtn"),
  clearCacheBtn: document.querySelector("#clearCacheBtn"),
  apiNotice: document.querySelector("#apiNotice"),
  sentenceTabs: document.querySelector("#sentenceTabs"),
  analysisView: document.querySelector("#analysisView"),
  wordBook: document.querySelector("#wordBook"),
  reviewBookBtn: document.querySelector("#reviewBookBtn"),
  clearBookBtn: document.querySelector("#clearBookBtn"),
  detailDrawer: document.querySelector("#detailDrawer"),
  drawerCard: document.querySelector(".drawer-card"),
  detailContent: document.querySelector("#detailContent"),
  closeDrawerBtn: document.querySelector("#closeDrawerBtn")
};

purgeLegacySentenceCache();

elements.appendArticleBtn.addEventListener("click", appendToArticle);
elements.joinArticleBtn.addEventListener("click", joinToLastParagraph);
elements.replaceArticleBtn.addEventListener("click", replaceArticle);
elements.clearArticleBtn.addEventListener("click", clearArticle);
elements.analyzeBtn.addEventListener("click", layoutTextOnly);
elements.clearCacheBtn.addEventListener("click", clearCache);

function showMinimumLayer() {
  state.visibleLayer = 1;
  renderAnalysis();
}

function addVisibleLayer() {
  const sentences = state.analysis?.sentences || [];
  if (!sentences.length) return;

  const maxLayer = Math.max(1, ...sentences.flatMap((sentence) => sentence.layers || [{ level: 1 }]).map((layer) => Number(layer.level) || 1));
  if (state.visibleLayer === "all") {
    state.visibleLayer = 1;
    renderAnalysis();
    return;
  }
  state.visibleLayer = Math.min(maxLayer, state.visibleLayer + 1);
  renderAnalysis();
}

elements.reviewBookBtn.addEventListener("click", startReview);
elements.clearBookBtn.addEventListener("click", () => {
  state.book = {};
  saveBook();
  renderBook();
});
elements.closeDrawerBtn.addEventListener("click", closeDrawer);
elements.drawerCard.addEventListener("pointerdown", startDrawerDrag);
elements.drawerCard.addEventListener("pointermove", moveDrawer);
elements.drawerCard.addEventListener("pointerup", stopDrawerDrag);
elements.drawerCard.addEventListener("pointercancel", stopDrawerDrag);
window.addEventListener("resize", clampDrawerPosition);

renderBook();

function layoutTextOnly() {
  const rawText = getArticleText();
  if (!rawText) {
    elements.apiNotice.textContent = "请先把段落追加到文章草稿。";
    return;
  }

  const article = buildArticleModel(rawText);
  const text = article.text;
  elements.articleText.value = text;
  state.sourceContext = text;
  state.paragraphBreaks = article.breaks;
  state.analysis = {
    sentences: article.sentences.map((sentence, index) => createSentenceFromCache(sentence, index, text))
  };
  state.visibleLayer = "all";
  state.activeSentenceIndex = null;
  state.usage = null;
  state.explanationCache.clear();
  renderTabs();
  renderAnalysis();
  const cachedCount = state.analysis.sentences.filter((sentence) => sentence.analyzed).length;
  elements.apiNotice.textContent = cachedCount
    ? `已排版 ${state.analysis.sentences.length} 个句子，并从缓存恢复 ${cachedCount} 个已分析句子。`
    : `已排版 ${state.analysis.sentences.length} 个句子。点击句子后才会分析。`;
}

function appendToArticle() {
  const chunk = elements.sourceText.value.trim();
  if (!chunk) {
    elements.apiNotice.textContent = "请先在“本次粘贴内容”里粘贴段落。";
    return;
  }

  elements.articleText.value = appendArticlePart(elements.articleText.value, chunk);
  elements.sourceText.value = "";
  elements.apiNotice.textContent = "已按新段落追加到文章草稿，并保留本次粘贴里的段落结构。";
}

function joinToLastParagraph() {
  const chunk = elements.sourceText.value.trim();
  if (!chunk) {
    elements.apiNotice.textContent = "请先在“本次粘贴内容”里粘贴要接上的内容。";
    return;
  }

  elements.articleText.value = appendArticlePart(elements.articleText.value, chunk, { sameParagraph: true });
  elements.sourceText.value = "";
  elements.apiNotice.textContent = "已接到文章草稿的上一段末尾。";
}

function replaceArticle() {
  const chunk = elements.sourceText.value.trim();
  if (!chunk) {
    elements.apiNotice.textContent = "请先在“本次粘贴内容”里粘贴段落。";
    return;
  }

  elements.articleText.value = chunk;
  elements.sourceText.value = "";
  elements.apiNotice.textContent = "已用本次粘贴内容替换文章草稿。";
}

function clearArticle() {
  elements.articleText.value = "";
  elements.sourceText.value = "";
  state.sourceContext = "";
  state.analysis = null;
  state.visibleLayer = "all";
  state.activeSentenceIndex = null;
  state.paragraphBreaks = [];
  state.usage = null;
  state.explanationCache.clear();
  renderTabs();
  renderAnalysis();
  elements.apiNotice.textContent = "文章草稿已清空。";
}

async function clearCache() {
  elements.clearCacheBtn.disabled = true;
  elements.apiNotice.textContent = "正在清除缓存...";

  try {
    const localCount = clearLocalSentenceCache();
    state.explanationCache.clear();

    const response = await fetch("/api/clear-cache", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "清除服务器缓存失败。");

    const resetCount = resetDisplayedAnalysis();
    elements.apiNotice.textContent = `缓存已清除：浏览器 ${localCount} 条，服务器 ${data.clearedFiles || 0} 个文件；当前页面已重置 ${resetCount} 个分析结果。`;
  } catch (error) {
    elements.apiNotice.textContent = error.message || "清除缓存失败。";
  } finally {
    elements.clearCacheBtn.disabled = false;
  }
}

function resetDisplayedAnalysis() {
  const sentences = state.analysis?.sentences || [];
  if (!sentences.length) return 0;

  const resetCount = sentences.filter((sentence) => sentence.analyzed).length;
  state.analysis = {
    ...state.analysis,
    sentences: sentences.map((sentence, index) => createDraftSentence(sentence.text, index, sentence.context || state.sourceContext || sentence.text))
  };
  state.visibleLayer = "all";
  state.activeSentenceIndex = null;
  state.usage = null;
  closeDrawer();
  renderTabs();
  renderAnalysis();
  return resetCount;
}

function getArticleText() {
  const article = elements.articleText.value.trim();
  if (article) return article;
  return elements.sourceText.value.trim();
}

function appendArticlePart(current, next, options = {}) {
  const base = current.trim();
  const addition = normalizePastedArticleText(next);
  if (!base) return addition;
  return options.sameParagraph ? `${base} ${addition}` : `${base}\n\n${addition}`;
}

function normalizePastedArticleText(text) {
  return getArticleParagraphs(text).join("\n\n");
}

function normalizeAnalysis(data) {
  return {
    ...data,
    sentences: (data.sentences || []).map((sentence, index) => {
      const sentenceText = sentence.text || sentence.sentence_info?.original_sentence || "";
      const skeleton = normalizeSkeleton(sentence.skeleton || analysisToSkeleton(sentence.analysis, sentenceText), sentenceText);
      const layers = skeleton
        ? skeletonToLayers(skeleton)
        : normalizeLayers(sentence.layers || sentence.analysis, sentenceText, sentence.translation || "");
      const normalized = {
        id: sentence.id || `s${index + 1}`,
        text: sentenceText,
        context: sentence.context || data.context || state.sourceContext || sentenceText,
        translation: sentence.translation || skeleton?.full?.translation_cn || layers.at(-1)?.chinese || "",
        tokens: skeleton
          ? deriveTokenLayersFromSkeleton(sentenceText, skeleton, sentence.tokens)
          : normalizeTokens(sentence.tokens, sentenceText),
        skeleton: skeleton || layersToSkeleton(layers, sentenceText),
        layers,
        phrases: normalizeKeyPhrases(sentence.key_phrases || sentence.phrases || []),
        wordAnalysis: normalizeWordAnalyses(sentence.word_analysis || sentence.wordAnalysis || []),
        analyzed: Boolean(sentence.analyzed),
        status: sentence.status || "done"
      };
      normalized.phraseMatches = buildPhraseMatches(normalized.tokens, normalized.phrases);
      return normalized;
    })
  };
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

function getSkeletonEntries(skeleton) {
  if (!skeleton || typeof skeleton !== "object") return [];
  const steps = Object.entries(skeleton)
    .filter(([key]) => /^step_\d+$/.test(key))
    .sort(([left], [right]) => Number(left.slice(5)) - Number(right.slice(5)));
  if (skeleton.full) steps.push(["full", skeleton.full]);
  return steps;
}

function analysisToSkeleton(rawAnalysis, sentenceText) {
  if (!Array.isArray(rawAnalysis)) return null;

  const levels = rawAnalysis
    .map((level, index) => {
      if (Array.isArray(level)) {
        return {
          level: Number(level[0] || index + 1),
          english: level[1] || "",
          chinese: level[2] || "",
          component_added: "",
          added_english_chunk: level[3] || "",
          added_chinese_chunk: level[4] || ""
        };
      }
      return {
        level: Number(level.level || index + 1),
        english: level.english || level.text || "",
        chinese: level.chinese || level.translation_cn || level.zh || "",
        component_added: level.component_added || level.note || level.change_note_cn || "",
        added_english_chunk: level.added_english_chunk || level.added_en || level.added_english || "",
        added_chinese_chunk: level.added_chinese_chunk || level.added_cn || ""
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
      added_cn: value.added_cn || ""
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
      change_note_cn: String(value.change_note_cn || value.note || value.component_added || "").trim(),
      added_en: String(value.added_en || value.added_english || value.added_english_chunk || "").trim(),
      added_cn: String(value.added_cn || value.added_chinese_chunk || "").trim()
    };
  });

  const entries = getSkeletonEntries(normalized);
  if (entries.length && !normalized.full) {
    const [lastKey, lastValue] = entries.at(-1);
    delete normalized[lastKey];
    normalized.full = { ...lastValue, text: sentenceText || lastValue.text };
  }

  if (normalized.full && sentenceText) {
    normalized.full.text = sentenceText;
  }

  const compacted = compactSkeleton(normalized, sentenceText);
  return Object.keys(compacted).length ? compacted : null;
}

function skeletonToLayers(skeleton) {
  return getSkeletonEntries(skeleton)
    .map(([key, value], index) => ({
      level: index + 1,
      key,
      english: value.text,
      chinese: value.translation_cn,
      note: value.change_note_cn,
      added_en: value.added_en || "",
      added_cn: value.added_cn || ""
    }))
    .filter((layer) => layer.english || layer.chinese);
}

function normalizeLayers(layers, text, translation) {
  const normalized = (layers || [])
    .map((layer, index) => ({
      level: Number(layer.level || index + 1),
      key: layer.key || "",
      english: layer.english || layer.text || "",
      chinese: layer.chinese || layer.translation_cn || layer.zh || "",
      note: layer.note || layer.change_note_cn || layer.component_added || "",
      added_en: layer.added_en || layer.added_english || layer.added_english_chunk || "",
      added_cn: layer.added_cn || layer.added_chinese_chunk || ""
    }))
    .filter((layer) => layer.english || layer.chinese);

  return normalized.length
    ? normalized
    : [{ level: 1, key: "full", english: text || "", chinese: translation || "", note: "" }];
}

function layersToSkeleton(layers, sentenceText) {
  if (!layers.length) return null;

  return layers.reduce((skeleton, layer, index) => {
    const isFull = index === layers.length - 1;
    const key = isFull ? "full" : `step_${index + 1}`;
    skeleton[key] = {
      text: String(isFull && sentenceText ? sentenceText : layer.english || "").trim(),
      translation_cn: String(layer.chinese || "").trim(),
      change_note_cn: String(layer.note || "").trim(),
      added_en: String(layer.added_en || "").trim(),
      added_cn: String(layer.added_cn || "").trim()
    };
    return skeleton;
  }, {});
}

function createDraftSentence(text, index, context) {
  return {
    id: `s${index + 1}`,
    text,
    context,
    translation: "",
    tokens: [],
    skeleton: null,
    layers: [],
    phrases: [],
    phraseMatches: new Map(),
    analyzed: false,
    status: "idle"
  };
}

function createSentenceFromCache(text, index, context) {
  const cached = loadCachedSentenceAnalysis(text, index, context);
  if (!cached) return createDraftSentence(text, index, context);

  return normalizeAnalysis({
    sentences: [{
      ...cached,
      id: `s${index + 1}`,
      text,
      context,
      analyzed: true,
      status: "done"
    }]
  }).sentences[0];
}

function splitTokenText(text) {
  return String(text || "").match(/[A-Za-z]+(?:['’][A-Za-z]+)?|\d+(?:[.,]\d+)*|[^\sA-Za-z\d]/g) || [];
}

function normalizeTokens(tokens, fallbackText) {
  const normalized = (tokens || [])
    .map((token) => ({
      text: token.text ?? token.value ?? token.token ?? Object.values(token).find((value) => typeof value === "string") ?? "",
      layer: Number(token.layer || 1)
    }))
    .filter((token) => token.text);

  return normalized.length ? normalized : fallbackTokens(fallbackText);
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
  return derived.length ? derived : normalizeTokens(rawTokens, sentenceText);
}

function fallbackTokens(text) {
  return (text.match(/[A-Za-z]+(?:'[A-Za-z]+)?|\d+|[^\sA-Za-z\d]/g) || []).map((token, index) => ({
    text: token,
    layer: index < 3 ? 1 : 2
  }));
}

function buildPhraseMatches(tokens, phrases) {
  const wordPositions = tokens
    .flatMap((token, index) => getWordPieces(token.text).map((word) => ({ index, word })));
  const matchesByToken = new Map();

  phrases.forEach((phrase, phraseIndex) => {
    const phraseWords = getPhraseMatchWords(phrase.text);
    if (!phraseWords.length) return;

    const tokenIndexes = findPhraseTokenIndexes(wordPositions, phraseWords);
    if (tokenIndexes.length) {
      const match = {
        ...phrase,
        id: phrase.id || `phrase-${phraseIndex + 1}`,
        tokenIndexes
      };
      match.tokenIndexes.forEach((tokenIndex) => {
        if (!matchesByToken.has(tokenIndex)) matchesByToken.set(tokenIndex, []);
        matchesByToken.get(tokenIndex).push(match);
      });
    }
  });

  return matchesByToken;
}

function getPhraseMatchWords(text) {
  return getWordPieces(String(text || "").replace(/\.{2,}|…+/g, " "));
}

function findPhraseTokenIndexes(wordPositions, phraseWords) {
  for (let start = 0; start <= wordPositions.length - phraseWords.length; start += 1) {
    const windowWords = wordPositions.slice(start, start + phraseWords.length).map((item) => item.word);
    if (windowWords.join(" ") === phraseWords.join(" ")) {
      return uniqueTokenIndexes(wordPositions.slice(start, start + phraseWords.length).map((item) => item.index));
    }
  }

  const tokenIndexes = [];
  let cursor = 0;
  for (const phraseWord of phraseWords) {
    const foundIndex = wordPositions.findIndex((item, index) => index >= cursor && wordsLooselyMatch(item.word, phraseWord));
    if (foundIndex === -1) return [];
    tokenIndexes.push(wordPositions[foundIndex].index);
    cursor = foundIndex + 1;
  }
  return uniqueTokenIndexes(tokenIndexes);
}

function wordsLooselyMatch(sourceWord, phraseWord) {
  if (sourceWord === phraseWord) return true;
  if (`${phraseWord}d` === sourceWord || `${phraseWord}ed` === sourceWord) return true;
  if (phraseWord.endsWith("e") && `${phraseWord}d` === sourceWord) return true;
  if (phraseWord.endsWith("y") && `${phraseWord.slice(0, -1)}ied` === sourceWord) return true;
  return false;
}

function getWordPieces(value) {
  return String(value || "")
    .match(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)?/g)
    ?.map((word) => word.toLowerCase())
    .filter(Boolean) || [];
}

function uniqueTokenIndexes(indexes) {
  return [...new Set(indexes)];
}

function isSelectableWordToken(value) {
  return /^[A-Za-z0-9]+(?:[-'’][A-Za-z0-9]+)*$/.test(String(value || ""));
}

function renderTabs() {
  elements.sentenceTabs.innerHTML = "";
  if (!state.analysis?.sentences?.length) return;

  const status = document.createElement("p");
  status.className = "analysis-summary";
  const analyzedCount = state.analysis.sentences.filter((sentence) => sentence.analyzed).length;
  status.textContent = `已按原文段落排版 ${state.analysis.sentences.length} 个句子，已分析 ${analyzedCount} 个。`;
  elements.sentenceTabs.append(status);
}

function renderAnalysis() {
  const sentences = state.analysis?.sentences || [];
  if (!sentences.length) {
    elements.analysisView.className = "analysis-view empty-state";
    elements.analysisView.textContent = "多次粘贴的段落可以先追加到同一篇文章草稿，再点击“排版正文”；正文会按段落和句子固定展示，选择某一句后再按需分析。";
    return;
  }

  elements.analysisView.className = "analysis-view";
  elements.analysisView.innerHTML = renderParagraphs(sentences);
  bindTokenEvents();
  bindParagraphDrag();
}

function renderParagraphs(sentences) {
  return getParagraphSentenceGroups(sentences).map((group, paragraphIndex) => `
    <section class="paragraph-block" draggable="true" data-paragraph-index="${paragraphIndex}">
      <div class="paragraph-tools" aria-hidden="true">
        <span class="drag-handle">拖动段落</span>
      </div>
      <p class="article-paragraph">
        ${group.sentences.map((sentence, groupSentenceIndex) => renderArticleSentence(sentence, group.startIndex + groupSentenceIndex, groupSentenceIndex === 0)).join(" ")}
      </p>
      ${renderActiveSentencePanel(group)}
    </section>
  `).join("");
}

function renderArticleSentence(sentence, sentenceIndex, isParagraphStart) {
  const classes = ["article-sentence"];
  if (sentence.analyzed) classes.push("analyzed");
  if (sentence.status === "loading") classes.push("loading");
  if (sentence.status === "error") classes.push("error");
  if (state.activeSentenceIndex === sentenceIndex) classes.push("active");

  const label = sentence.status === "loading"
    ? "正在分析此句"
    : sentence.status === "error"
      ? "重新分析此句"
      : sentence.analyzed
        ? "查看已分析句子"
        : "分析此句";

  const editButton = sentenceIndex === 0
    ? ""
    : isParagraphStart
      ? `<button class="sentence-edit-btn" data-sentence-edit="join-previous" data-sentence-index="${sentenceIndex}" title="把这一整段接到上一段末尾">接上段</button>`
      : `<button class="sentence-edit-btn" data-sentence-edit="start-paragraph" data-sentence-index="${sentenceIndex}" title="在这句前面加入段落边界，设为新段首">段首</button>`;

  const loadingIndicator = sentence.status === "loading" ? `<span class="sentence-loading" aria-label="正在分析"></span>` : "";
  return `<span class="sentence-unit">${editButton}<span class="${classes.join(" ")}" role="button" tabindex="0" data-article-sentence-index="${sentenceIndex}" title="${label}">${escapeHtml(sentence.text)}</span>${loadingIndicator}</span>`;
}

function renderActiveSentencePanel(group) {
  const activeIndex = state.activeSentenceIndex;
  if (activeIndex === null || activeIndex < group.startIndex || activeIndex >= group.startIndex + group.sentences.length) return "";

  const sentence = state.analysis?.sentences?.[activeIndex];
  if (!sentence?.analyzed) return "";
  return renderSentenceCard(sentence, activeIndex);
}

function getParagraphSentenceGroups(sentences) {
  const groups = [];
  if (!sentences.length) return groups;

  const breaks = normalizeParagraphBreaks(sentences);
  let startIndex = 0;
  for (let index = 1; index <= sentences.length; index += 1) {
    if (index < sentences.length && !breaks[index]) continue;

    const paragraphSentences = sentences.slice(startIndex, index);
    groups.push({
      startIndex,
      sentences: paragraphSentences,
      paragraph: paragraphSentences.map((sentence) => sentence.text).join(" ")
    });
    startIndex = index;
  }

  return groups.filter((group) => group.sentences.length);
}

function normalizeParagraphBreaks(sentences) {
  const breaks = Array(sentences.length).fill(false);
  breaks[0] = true;
  (state.paragraphBreaks || []).forEach((value, index) => {
    if (index < breaks.length) breaks[index] = Boolean(value);
  });
  breaks[0] = true;
  return breaks;
}

function buildArticleModel(text) {
  const paragraphs = getArticleParagraphs(text);
  const sentences = [];
  const breaks = [];

  paragraphs.forEach((paragraph) => {
    splitTextIntoSentences(paragraph).forEach((sentence, sentenceIndex) => {
      breaks.push(sentenceIndex === 0);
      sentences.push(sentence);
    });
  });

  if (breaks.length) breaks[0] = true;
  return {
    paragraphs,
    text: paragraphs.join("\n\n"),
    sentences,
    breaks
  };
}

function getArticleParagraphs(text) {
  const normalized = String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();
  if (!normalized) return [];

  return normalized
    .split(/\n\s*\n\s*\n+/g)
    .flatMap((section) => mergeSentenceSeparatedBlocks(section
      .split(/\n\s*\n/g)
      .map(normalizeParagraphLines)
      .filter(Boolean)))
    .filter(Boolean);
}

function normalizeParagraphLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeSentenceSeparatedBlocks(blocks) {
  const paragraphs = [];
  let current = "";

  blocks.forEach((block) => {
    if (!current) {
      current = block;
      return;
    }

    if (shouldMergeParagraphBlocks(current, block)) {
      current = `${current} ${block}`.replace(/\s+/g, " ").trim();
      return;
    }

    paragraphs.push(current);
    current = block;
  });

  if (current) paragraphs.push(current);
  return paragraphs;
}

function shouldMergeParagraphBlocks(previous, next) {
  const previousSentences = splitTextIntoSentences(previous).length;
  const nextSentences = splitTextIntoSentences(next).length;
  if (previousSentences <= 1 || nextSentences <= 1) return true;
  return previous.length < 220 || next.length < 220;
}

function splitTextIntoSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .match(/[^.!?]+[.!?]?/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [];
}

function renderSentenceCard(sentence, sentenceIndex) {
  if (!sentence.analyzed) return renderDraftSentenceCard(sentence, sentenceIndex);

  const maxLayer = Math.max(1, ...(sentence.layers || [{ level: 1 }]).map((layer) => Number(layer.level) || 1));
  const isFullTextView = state.visibleLayer === "all";
  const effectiveLayer = isFullTextView ? maxLayer : Math.min(state.visibleLayer, maxLayer);
  const currentLayer = sentence.layers.find((layer) => Number(layer.level) === effectiveLayer) || sentence.layers.at(-1);
  const previousLayerData = sentence.layers.find((layer) => Number(layer.level) === effectiveLayer - 1);
  const previousLayer = Math.max(0, effectiveLayer - 1);
  const highlightedChinese = isFullTextView
    ? escapeHtml(sentence.translation || currentLayer?.chinese || "")
    : highlightChineseAddition(currentLayer?.chinese || sentence.translation, previousLayerData?.chinese || "", currentLayer?.added_cn || "");
  const changeNote = currentLayer?.note
    ? `<div class="change-note">${escapeHtml(currentLayer.note)}</div>`
    : "";

  return `
    <article class="sentence-card" data-sentence-index="${sentenceIndex}">
      <button class="analysis-close-btn" data-close-analysis type="button" aria-label="关闭分析">×</button>
      <div class="analysis-card-actions">
        <button class="secondary-btn compact-btn" data-layer-action="minimum" type="button">显示最小主干</button>
        <button class="secondary-btn compact-btn" data-layer-action="add" type="button">添加主干信息</button>
      </div>
      <div class="sentence-text">${renderTokens(sentence, previousLayer, sentenceIndex, effectiveLayer)}</div>
      <div class="translation">${highlightedChinese}</div>
      ${changeNote}
    </article>
  `;
}

function renderDraftSentenceCard(sentence, sentenceIndex) {
  const isLoading = sentence.status === "loading";
  const hasError = sentence.status === "error";
  return `
    <article class="sentence-card draft-sentence ${hasError ? "error" : ""}" data-sentence-index="${sentenceIndex}">
      <div class="draft-sentence-head">
        <span class="sentence-badge">第 ${sentenceIndex + 1} 句</span>
        <button class="secondary-btn analyze-sentence-btn" data-sentence-index="${sentenceIndex}" ${isLoading ? "disabled" : ""}>
          ${isLoading ? "分析中..." : hasError ? "重新分析" : "分析此句"}
        </button>
      </div>
      <p class="draft-sentence-text">${escapeHtml(sentence.text)}</p>
      ${hasError ? `<p class="sentence-error">${escapeHtml(sentence.error || "分析失败")}</p>` : ""}
    </article>
  `;
}

function renderTokens(sentence, previousLayer, sentenceIndex, effectiveLayer) {
  const parts = [];
  let newRun = [];
  let previousTokenText = "";

  sentence.tokens.forEach((token, index) => {
    const layer = Number(token.layer || 1);
    const isNew = effectiveLayer > 1 && layer === effectiveLayer && effectiveLayer > previousLayer && state.visibleLayer !== "all";
    const separator = shouldSeparateTokens(previousTokenText, token.text) ? " " : "";
    const html = `${separator}${renderToken(sentence, token, index, layer, isNew, sentenceIndex, effectiveLayer)}`;

    if (isNew) {
      newRun.push(html);
      previousTokenText = token.text;
      return;
    }

    flushNewRun(parts, newRun);
    newRun = [];
    parts.push(html);
    previousTokenText = token.text;
  });

  flushNewRun(parts, newRun);
  return parts.join("");
}

function shouldSeparateTokens(previous, next) {
  if (!previous || !next) return false;
  if (/^[,.;:!?%)}\]”’]$/.test(next)) return false;
  if (/^[(\[{“‘]$/.test(previous)) return false;
  return true;
}

function renderToken(sentence, token, index, layer, isNew, sentenceIndex, effectiveLayer) {
  const phraseMatches = sentence.phraseMatches.get(index) || [];
  const classes = ["token"];
  if (layer > effectiveLayer) classes.push("dim");
  if (isNew) classes.push("new");
  if (phraseMatches.length) classes.push("phrase-member");

  if (isSelectableWordToken(token.text)) {
    return `<button class="${classes.join(" ")} token-btn" data-sentence-index="${sentenceIndex}" data-token-index="${index}" data-word="${escapeHtml(token.text)}">${escapeHtml(token.text)}</button>`;
  }
  return `<span class="${classes.join(" ")}" data-sentence-index="${sentenceIndex}" data-token-index="${index}">${escapeHtml(token.text)}</span>`;
}

function flushNewRun(parts, run) {
  if (!run.length) return;
  parts.push(`<span class="token-run new-run">${run.join("")}</span>`);
}

function bindTokenEvents() {
  const sentenceCards = elements.analysisView.querySelectorAll(".sentence-card");

  elements.analysisView.querySelectorAll("[data-article-sentence-index]").forEach((button) => {
    const selectSentence = () => {
      const sentenceIndex = Number(button.dataset.articleSentenceIndex);
      const sentence = state.analysis?.sentences?.[sentenceIndex];
      if (!sentence) return;
      if (sentence.analyzed) {
        if (state.activeSentenceIndex === sentenceIndex) {
          state.activeSentenceIndex = null;
          renderAnalysis();
          return;
        }
        state.activeSentenceIndex = sentenceIndex;
        renderAnalysis();
        return;
      }
      analyzeSingleSentence(sentenceIndex);
    };

    button.addEventListener("click", selectSentence);
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectSentence();
    });
  });

  elements.analysisView.querySelectorAll("[data-sentence-edit]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      editSentenceParagraphBoundary(Number(button.dataset.sentenceIndex), button.dataset.sentenceEdit);
    });
  });

  elements.analysisView.querySelectorAll("[data-close-analysis]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.activeSentenceIndex = null;
      renderAnalysis();
    });
  });

  elements.analysisView.querySelectorAll("[data-layer-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (button.dataset.layerAction === "minimum") {
        showMinimumLayer();
        return;
      }
      addVisibleLayer();
    });
  });

  sentenceCards.forEach((sentenceCard) => {
    const sentence = state.analysis.sentences[Number(sentenceCard.dataset.sentenceIndex)];
    if (!sentence?.analyzed) return;
    const tokenButtons = sentenceCard.querySelectorAll("[data-word]");

    tokenButtons.forEach((button) => {
      button.addEventListener("mouseenter", () => showTokenHover(sentence, button, sentenceCard));
      button.addEventListener("focus", () => showTokenHover(sentence, button, sentenceCard));
      button.addEventListener("click", (event) => chooseTokenTarget(event, sentence, button, sentenceCard));
    });

    sentenceCard.addEventListener("mouseleave", (event) => {
      if (!sentenceCard.contains(event.relatedTarget)) clearTokenHover(sentenceCard);
    });
    sentenceCard.addEventListener("mouseover", (event) => {
      if (event.target.closest("[data-word]") || event.target.closest(".token-select-popover")) return;
      if (sentenceCard.querySelector(".token-select-popover")) return;
      clearTokenHover(sentenceCard);
    });
    sentenceCard.addEventListener("click", (event) => {
      if (event.target.closest("[data-word]") || event.target.closest(".token-select-popover")) return;
      clearTokenHover(sentenceCard);
    });
  });
}

function bindParagraphDrag() {
  const blocks = [...elements.analysisView.querySelectorAll(".paragraph-block")];

  blocks.forEach((block) => {
    block.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", block.dataset.paragraphIndex);
      block.classList.add("dragging");
    });

    block.addEventListener("dragend", () => {
      blocks.forEach((item) => item.classList.remove("dragging", "drag-over"));
    });

    block.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      blocks.forEach((item) => item.classList.remove("drag-over"));
      block.classList.add("drag-over");
    });

    block.addEventListener("dragleave", () => {
      block.classList.remove("drag-over");
    });

    block.addEventListener("drop", (event) => {
      event.preventDefault();
      const fromIndex = Number(event.dataTransfer.getData("text/plain"));
      const toIndex = Number(block.dataset.paragraphIndex);
      blocks.forEach((item) => item.classList.remove("dragging", "drag-over"));
      reorderParagraphs(fromIndex, toIndex);
    });
  });
}

function reorderParagraphs(fromIndex, toIndex) {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex === toIndex) return;

  const groups = getParagraphSentenceGroups(state.analysis?.sentences || []);
  if (!groups[fromIndex] || !groups[toIndex]) return;

  const activeSentence = state.activeSentenceIndex === null ? null : state.analysis.sentences[state.activeSentenceIndex];
  const reordered = [...groups];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);

  const nextSentences = reordered.flatMap((group) => group.sentences);
  const activeNextIndex = activeSentence ? nextSentences.indexOf(activeSentence) : null;
  const nextText = reordered.map((group) => group.paragraph).join("\n\n");
  const nextBreaks = [];
  reordered.forEach((group) => {
    group.sentences.forEach((_, sentenceIndex) => {
      nextBreaks.push(sentenceIndex === 0);
    });
  });
  state.sourceContext = nextText;
  state.paragraphBreaks = nextBreaks;
  elements.articleText.value = nextText;
  state.analysis.sentences = nextSentences.map((sentence, index) => ({
    ...sentence,
    id: `s${index + 1}`,
    context: nextText
  }));
  state.activeSentenceIndex = activeNextIndex >= 0 ? activeNextIndex : null;
  renderTabs();
  renderAnalysis();
  elements.apiNotice.textContent = "段落顺序已更新，并同步到文章草稿。";
}

function editSentenceParagraphBoundary(sentenceIndex, action) {
  const sentences = state.analysis?.sentences || [];
  if (!sentences[sentenceIndex] || sentenceIndex <= 0) return;

  const breaks = getSentenceParagraphBreaks(sentences);
  if (action === "start-paragraph") {
    breaks[sentenceIndex] = true;
  } else if (action === "join-previous") {
    breaks[sentenceIndex] = false;
  } else {
    return;
  }

  applyParagraphBreaks(breaks);
  elements.apiNotice.textContent = action === "start-paragraph"
    ? `第 ${sentenceIndex + 1} 句已设为新段落起始句。`
    : `第 ${sentenceIndex + 1} 句已接到上一段。`;
}

function getSentenceParagraphBreaks(sentences) {
  return normalizeParagraphBreaks(sentences);
}

function applyParagraphBreaks(breaks) {
  const sentences = state.analysis?.sentences || [];
  const paragraphs = [];
  let current = [];

  sentences.forEach((sentence, index) => {
    if (index > 0 && breaks[index] && current.length) {
      paragraphs.push(current);
      current = [];
    }
    current.push(sentence);
  });
  if (current.length) paragraphs.push(current);

  const nextText = paragraphs.map((paragraph) => paragraph.map((sentence) => sentence.text).join(" ")).join("\n\n");
  state.sourceContext = nextText;
  state.paragraphBreaks = breaks;
  elements.articleText.value = nextText;
  state.analysis.sentences = sentences.map((sentence, index) => ({
    ...sentence,
    id: `s${index + 1}`,
    context: nextText
  }));
  renderTabs();
  renderAnalysis();
}

async function analyzeSingleSentence(sentenceIndex) {
  const sentence = state.analysis?.sentences?.[sentenceIndex];
  if (!sentence || sentence.status === "loading") return;

  sentence.status = "loading";
  sentence.error = "";
  state.activeSentenceIndex = sentenceIndex;
  renderTabs();
  renderAnalysis();
  elements.apiNotice.textContent = `正在分析第 ${sentenceIndex + 1} 句。`;

  try {
    const response = await fetch("/api/analyze-sentence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: sentence.text,
        context: state.sourceContext || sentence.context || sentence.text,
        index: sentenceIndex
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "分析失败");

    const normalized = normalizeAnalysis({
      sentences: [{
        ...data.sentence,
        id: sentence.id,
        context: state.sourceContext || sentence.context,
        analyzed: true,
        status: "done"
      }]
    }).sentences[0];
    state.analysis.sentences[sentenceIndex] = normalized;
    saveCachedSentenceAnalysis(normalized, sentenceIndex, state.sourceContext || sentence.context || sentence.text);
    state.activeSentenceIndex = sentenceIndex;
    state.usage = data.usage || state.usage;
    renderTabs();
    renderAnalysis();
    elements.apiNotice.textContent = data.cached
      ? `第 ${sentenceIndex + 1} 句来自缓存，无需重新分析。`
      : `第 ${sentenceIndex + 1} 句分析完成。${data.usage ? formatUsage(data.usage) : ""}`;
  } catch (error) {
    state.analysis.sentences[sentenceIndex] = {
      ...sentence,
      status: "error",
      error: error.message || "分析失败"
    };
    renderTabs();
    renderAnalysis();
    elements.apiNotice.textContent = error.message || "分析失败";
  }
}

function getSentenceCacheKey(text, index, context) {
  return `readingAssistantSentence:${hashString(JSON.stringify({
    version: SENTENCE_CACHE_VERSION,
    index,
    text: String(text || "").trim(),
    context: String(context || "").trim()
  }))}`;
}

function purgeLegacySentenceCache() {
  const markerKey = "readingAssistantSentenceCacheVersion";
  const currentVersion = String(SENTENCE_CACHE_VERSION);
  if (localStorage.getItem(markerKey) === currentVersion) return;

  clearLocalSentenceCache();
  localStorage.setItem(markerKey, currentVersion);
}

function clearLocalSentenceCache() {
  const sentenceKeys = Object.keys(localStorage)
    .filter((key) => key.startsWith("readingAssistantSentence:"));
  sentenceKeys.forEach((key) => localStorage.removeItem(key));
  return sentenceKeys.length;
}

function loadCachedSentenceAnalysis(text, index, context) {
  try {
    const raw = localStorage.getItem(getSentenceCacheKey(text, index, context));
    if (!raw) return null;
    const cached = JSON.parse(raw);
    return cached?.sentence || null;
  } catch {
    return null;
  }
}

function saveCachedSentenceAnalysis(sentence, index, context) {
  try {
    localStorage.setItem(getSentenceCacheKey(sentence.text, index, context), JSON.stringify({
      cachedAt: new Date().toISOString(),
      sentence: {
        text: sentence.text,
        translation: sentence.translation,
        tokens: sentence.tokens,
        skeleton: sentence.skeleton,
        layers: sentence.layers,
        phrases: sentence.phrases,
        wordAnalysis: sentence.wordAnalysis || []
      }
    }));
  } catch {
    // localStorage can be full or unavailable; analysis still works without persistence.
  }
}

function hashString(value) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const ch = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

function chooseTokenTarget(event, sentence, tokenButton, sentenceCard) {
  event.stopPropagation();
  const tokenIndex = Number(tokenButton.dataset.tokenIndex);
  const phraseMatches = sentence.phraseMatches.get(tokenIndex) || [];

  if (!phraseMatches.length) {
    clearTokenHover(sentenceCard);
    explainTerm(tokenButton.dataset.word, "word", sentence);
    return;
  }

  showTokenHover(sentence, tokenButton, sentenceCard, { pinned: true });
}

function showTokenHover(sentence, tokenButton, sentenceCard, options = {}) {
  clearTokenHover(sentenceCard);
  const tokenIndex = Number(tokenButton.dataset.tokenIndex);
  const phraseMatches = sentence.phraseMatches.get(tokenIndex) || [];
  tokenButton.classList.add("word-hover");

  phraseMatches.forEach((phrase) => {
    phrase.tokenIndexes.forEach((index) => {
      const tokenElement = sentenceCard.querySelector(`[data-token-index="${index}"]`);
      tokenElement?.classList.add("phrase-hover");
    });
  });

  if (options.pinned && phraseMatches.length) {
    showTokenSelectPopover(sentence, tokenButton, phraseMatches, sentenceCard);
  }
}

function showTokenSelectPopover(sentence, tokenButton, phraseMatches, sentenceCard) {
  const popover = document.createElement("div");
  popover.className = "token-select-popover";
  popover.innerHTML = `
    <button class="target-choice" data-target-choice="word" type="button">单词：${escapeHtml(tokenButton.dataset.word)}</button>
    ${phraseMatches.map((phrase, phraseIndex) => `
      <button class="target-choice phrase-choice-option" data-target-choice="phrase:${phraseIndex}" type="button">词组：${escapeHtml(phrase.text)}</button>
    `).join("")}
  `;

  popover.addEventListener("click", (event) => event.stopPropagation());
  sentenceCard.appendChild(popover);
  positionTokenSelectPopover(popover, tokenButton, sentenceCard);

  const firstChoice = popover.querySelector("[data-target-choice]");
  firstChoice?.focus();
  popover.querySelectorAll("[data-target-choice]").forEach((choice) => {
    choice.addEventListener("click", (event) => {
      event.stopPropagation();
      const value = choice.dataset.targetChoice;
      if (!value) return;

      if (value === "word") {
        clearTokenHover(sentenceCard);
        explainTerm(tokenButton.dataset.word, "word", sentence);
        return;
      }

      const phraseIndex = Number(value.replace(/^phrase:/, ""));
      const phrase = phraseMatches[phraseIndex];
      if (phrase) {
        clearTokenHover(sentenceCard);
        explainTerm(phrase.text, "phrase", sentence);
      }
    });
  });

  popover.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      clearTokenHover(sentenceCard);
    }
  });
}

function positionTokenSelectPopover(popover, tokenButton, sentenceCard) {
  const tokenRect = tokenButton.getBoundingClientRect();
  const cardRect = sentenceCard.getBoundingClientRect();
  const padding = 12;
  const top = tokenRect.bottom - cardRect.top + 7;
  const naturalLeft = tokenRect.left - cardRect.left;
  const maxLeft = sentenceCard.clientWidth - popover.offsetWidth - padding;
  const left = Math.max(padding, Math.min(naturalLeft, Math.max(padding, maxLeft)));

  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
}

function clearTokenHover(scope = elements.analysisView) {
  scope.querySelectorAll(".phrase-hover, .word-hover").forEach((element) => {
    element.classList.remove("phrase-hover", "word-hover");
  });
  scope.querySelectorAll(".token-select-popover").forEach((popover) => popover.remove());
}

function highlightChineseAddition(currentText, previousText, addedText = "") {
  const current = String(currentText || "");
  const previous = String(previousText || "");
  const added = String(addedText || "");
  if (!current) return "";
  if (state.visibleLayer === "all" || state.visibleLayer === 1) return escapeHtml(current);
  if (added && current.includes(added)) {
    const start = current.indexOf(added);
    const end = start + added.length;
    return `${escapeHtml(current.slice(0, start))}<mark>${escapeHtml(current.slice(start, end))}</mark>${escapeHtml(current.slice(end))}`;
  }
  if (!previous) return `<mark>${escapeHtml(current)}</mark>`;

  const directAddition = getDirectAddedRange(previous, current);
  const additions = directAddition ? [directAddition] : mergeNearbyAddedRanges(getAddedRanges(previous, current), current);
  if (!additions.length) return escapeHtml(current);

  let html = "";
  let cursor = 0;
  additions.forEach(([start, end]) => {
    html += escapeHtml(current.slice(cursor, start));
    html += `<mark>${escapeHtml(current.slice(start, end))}</mark>`;
    cursor = end;
  });
  html += escapeHtml(current.slice(cursor));
  return html;
}

function getDirectAddedRange(previous, current) {
  const start = current.indexOf(previous);
  if (start >= 0) {
    if (current.length === previous.length) return null;
    if (start === 0) return [previous.length, current.length];
    if (start + previous.length === current.length) return [0, start];
  }

  let prefixLength = 0;
  while (
    prefixLength < previous.length &&
    prefixLength < current.length &&
    previous[prefixLength] === current[prefixLength]
  ) {
    prefixLength += 1;
  }

  let previousSuffix = previous.length - 1;
  let currentSuffix = current.length - 1;
  while (
    previousSuffix >= prefixLength &&
    currentSuffix >= prefixLength &&
    previous[previousSuffix] === current[currentSuffix]
  ) {
    previousSuffix -= 1;
    currentSuffix -= 1;
  }

  if (previousSuffix < prefixLength && currentSuffix >= prefixLength) {
    return [prefixLength, currentSuffix + 1];
  }
  return null;
}

function mergeNearbyAddedRanges(ranges, current) {
  if (ranges.length <= 1) return ranges;

  const merged = [];
  ranges.forEach((range) => {
    const previous = merged.at(-1);
    if (!previous) {
      merged.push([...range]);
      return;
    }

    const gap = current.slice(previous[1], range[0]);
    const shouldMerge = gap.length <= 4 || /^[\s，、的了和与及并或而]+$/.test(gap);
    if (shouldMerge) {
      previous[1] = range[1];
      return;
    }
    merged.push([...range]);
  });

  return merged;
}

function getAddedRanges(previous, current) {
  const previousChars = [...previous];
  const currentChars = [...current];
  const rows = previousChars.length + 1;
  const cols = currentChars.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = previousChars.length - 1; i >= 0; i -= 1) {
    for (let j = currentChars.length - 1; j >= 0; j -= 1) {
      dp[i][j] = previousChars[i] === currentChars[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const additions = [];
  let i = 0;
  let j = 0;
  let additionStart = null;

  const closeAddition = () => {
    if (additionStart !== null) {
      additions.push([additionStart, j]);
      additionStart = null;
    }
  };

  while (j < currentChars.length) {
    if (i < previousChars.length && previousChars[i] === currentChars[j]) {
      closeAddition();
      i += 1;
      j += 1;
    } else if (i < previousChars.length && dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      if (additionStart === null) additionStart = j;
      j += 1;
    }
  }
  closeAddition();

  return additions;
}

async function explainTerm(term, type, sentence) {
  const cacheKey = `${sentence.id}:${type}:${term.toLowerCase()}`;
  if (state.explanationCache.has(cacheKey)) {
    openDetail(state.explanationCache.get(cacheKey), sentence);
    return;
  }

  openLoadingDetail(term, type);

  try {
    const response = await fetch("/api/explain-term", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ term, type, sentence: sentence.text, context: sentence.context || state.sourceContext || sentence.text })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "释义失败");

    const explanation = {
      text: data.word || data.text || term,
      type: data.type || type,
      translation: data.contextMeaning || data.context_meaning || data.translation || "",
      rootAffix: data.rootAffix || data.root_affix || "",
      originMeaning: data.originMeaning || data.origin_meaning || "",
      evolutionChain: data.evolutionChain || data.evolution_chain || "",
      contextMeaning: data.contextMeaning || data.context_meaning || data.translation || "",
      semanticChain: data.semanticChain || buildSemanticChainFromCompactExplanation(data),
      usage: data.usage,
      cached: data.cached,
      demo: data.demo
    };
    state.explanationCache.set(cacheKey, explanation);
    openDetail(explanation, sentence);
  } catch (error) {
    elements.detailContent.innerHTML = `<h2>${escapeHtml(term)}</h2><p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

function buildSemanticChainFromCompactExplanation(data) {
  return [
    data.originMeaning || data.origin_meaning || "",
    data.evolutionChain || data.evolution_chain || ""
  ].filter(Boolean);
}

function openLoadingDetail(term, type) {
  elements.detailContent.innerHTML = `
    <p class="detail-meta">${type === "phrase" ? "固定词组" : "单词"} · 正在按需请求 API</p>
    <h2>${escapeHtml(term)}</h2>
    <p class="empty">正在生成本句描述性解释、词源/构成和语义演变路径...</p>
  `;
  elements.detailDrawer.classList.add("open");
  elements.detailDrawer.setAttribute("aria-hidden", "false");
}

function openDetail(item, sentence) {
  state.selectedItem = { ...item, sentenceId: sentence.id, sentenceText: sentence.text };
  const sourceIndex = (state.analysis?.sentences || []).findIndex((item) => item.id === sentence.id);
  const sourceText = sourceIndex >= 0 ? ` · 出自原文第 ${sourceIndex + 1} 句` : "";
  const usageText = item.cached
    ? `<p class="usage-line">来自本地缓存，本次 $0。</p>`
    : item.usage ? `<p class="usage-line">${formatUsage(item.usage)}</p>` : "";
  elements.detailContent.innerHTML = `
    <p class="detail-meta">${item.type === "phrase" ? "固定词组" : "单词"}${sourceText}</p>
    <h2>${escapeHtml(item.text)}</h2>
    ${usageText}
    <p><strong>词根词缀：</strong>${escapeHtml(item.rootAffix || "")}</p>
    ${item.originMeaning ? `<p><strong>最原始含义：</strong>${escapeHtml(item.originMeaning)}</p>` : ""}
    <div class="semantic-chain">${renderSemanticChain(item.semanticChain || [])}</div>
    <p><strong>当前语境含义：</strong>${escapeHtml(item.contextMeaning || item.translation || "")}</p>
    <button class="primary-btn add-word-btn" id="addWordBtn">加入单词本</button>
  `;
  elements.detailDrawer.classList.add("open");
  elements.detailDrawer.setAttribute("aria-hidden", "false");
  document.querySelector("#addWordBtn").addEventListener("click", () => addToBook(state.selectedItem));
}

function closeDrawer() {
  elements.detailDrawer.classList.remove("open");
  elements.detailDrawer.setAttribute("aria-hidden", "true");
  stopDrawerDrag();
}

function startDrawerDrag(event) {
  if (event.button !== 0) return;
  if (event.target.closest("button, a, input, textarea, select, summary")) return;

  const rect = elements.drawerCard.getBoundingClientRect();
  state.drawerDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: state.drawerOffset.x,
    originY: state.drawerOffset.y,
    rect
  };

  elements.drawerCard.classList.add("dragging");
  elements.drawerCard.setPointerCapture(event.pointerId);
}

function moveDrawer(event) {
  const drag = state.drawerDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();

  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  const padding = 8;
  const minDx = padding - drag.rect.left;
  const maxDx = window.innerWidth - padding - drag.rect.right;
  const minDy = padding - drag.rect.top;
  const maxDy = window.innerHeight - padding - drag.rect.bottom;

  setDrawerOffset(
    drag.originX + clamp(dx, minDx, maxDx),
    drag.originY + clamp(dy, minDy, maxDy)
  );
}

function stopDrawerDrag(event) {
  if (!state.drawerDrag) return;
  if (event && event.pointerId !== state.drawerDrag.pointerId) return;

  if (event && elements.drawerCard.hasPointerCapture(event.pointerId)) {
    elements.drawerCard.releasePointerCapture(event.pointerId);
  }
  state.drawerDrag = null;
  elements.drawerCard.classList.remove("dragging");
}

function setDrawerOffset(x, y) {
  state.drawerOffset = { x, y };
  elements.drawerCard.style.setProperty("--drawer-x", `${x}px`);
  elements.drawerCard.style.setProperty("--drawer-y", `${y}px`);
}

function clampDrawerPosition() {
  if (!elements.detailDrawer.classList.contains("open")) return;

  const rect = elements.drawerCard.getBoundingClientRect();
  const padding = 8;
  let nextX = state.drawerOffset.x;
  let nextY = state.drawerOffset.y;

  if (rect.left < padding) nextX += padding - rect.left;
  if (rect.right > window.innerWidth - padding) nextX -= rect.right - (window.innerWidth - padding);
  if (rect.top < padding) nextY += padding - rect.top;
  if (rect.bottom > window.innerHeight - padding) nextY -= rect.bottom - (window.innerHeight - padding);

  setDrawerOffset(nextX, nextY);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function renderSemanticChain(chain) {
  if (!chain.length) return `<span class="empty">暂无语义链。</span>`;
  return chain
    .map((step, index) => `<span class="chain-step">${escapeHtml(step)}</span>${index < chain.length - 1 ? `<span class="arrow">→</span>` : ""}`)
    .join("");
}

function addToBook(item) {
  const key = item.text.toLowerCase();
  const now = new Date().toISOString();
  if (!state.book[key]) state.book[key] = { text: item.text, entries: [] };
  state.book[key].entries.push({
    id: crypto.randomUUID(),
    text: item.text,
    type: item.type,
    translation: item.translation,
      rootAffix: item.rootAffix,
      originMeaning: item.originMeaning || "",
      evolutionChain: item.evolutionChain || "",
      contextMeaning: item.contextMeaning || "",
      semanticChain: item.semanticChain || [],
    addedAt: now,
    dueAt: now,
    intervalDays: 0,
    ease: 2.5,
    reviews: 0,
    lapses: 0,
    lastReviewedAt: null
  });
  saveBook();
  renderBook();
}

function renderBook() {
  migrateBook();
  const groups = Object.values(state.book);
  if (!groups.length) {
    elements.wordBook.className = "word-book empty";
    elements.wordBook.textContent = "还没有添加单词。";
    return;
  }

  elements.wordBook.className = "word-book";
  elements.wordBook.innerHTML = groups
    .map((group) => `
      <details class="word-group">
        <summary>${escapeHtml(group.text)} (${group.entries.length})</summary>
        ${group.entries.map((entry) => `
          <button class="word-entry" data-entry-id="${entry.id}" data-word-key="${escapeHtml(group.text.toLowerCase())}">
            ${escapeHtml(entry.translation || "语境义")}<br />
            <span class="entry-head">
              <span class="date-badge">加入 ${formatDate(entry.addedAt)}</span>
            </span>
            <span class="review-meta">${getReviewStatus(entry)}</span>
          </button>
        `).join("")}
      </details>
    `)
    .join("");

  elements.wordBook.querySelectorAll("[data-entry-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = state.book[button.dataset.wordKey];
      const entry = group?.entries.find((item) => item.id === button.dataset.entryId);
      if (entry) openBookEntry(entry);
    });
  });
}

function openBookEntry(entry) {
  elements.detailContent.innerHTML = `
    <p class="detail-meta">单词本记录 · ${entry.type === "phrase" ? "固定词组" : "单词"}</p>
    <h2>${escapeHtml(entry.text)}</h2>
    <p><strong>词源说明：</strong>${escapeHtml(entry.rootAffix || "")}</p>
    <div class="semantic-chain">${renderSemanticChain(entry.semanticChain || [])}</div>
  `;
  elements.detailDrawer.classList.add("open");
  elements.detailDrawer.setAttribute("aria-hidden", "false");
}

function startReview() {
  migrateBook();
  state.reviewQueue = getDueEntries();
  state.reviewIndex = 0;
  state.reviewFlipped = false;

  if (!state.reviewQueue.length) {
    elements.detailContent.innerHTML = `
      <p class="detail-meta">Anki 式复习</p>
      <h2>今天没有到期卡片</h2>
      <p class="empty">新加入的单词会默认进入今日复习。复习后会根据你的反馈安排下次出现时间。</p>
    `;
    elements.detailDrawer.classList.add("open");
    elements.detailDrawer.setAttribute("aria-hidden", "false");
    return;
  }

  renderReviewCard();
}

function renderReviewCard() {
  const entry = state.reviewQueue[state.reviewIndex];
  if (!entry) {
    elements.detailContent.innerHTML = `
      <p class="detail-meta">Anki 式复习</p>
      <h2>本轮复习完成</h2>
      <p>已根据你的反馈安排下次复习日期。</p>
    `;
    renderBook();
    return;
  }

  elements.detailContent.innerHTML = `
    <p class="detail-meta">Anki 式复习 · ${state.reviewIndex + 1} / ${state.reviewQueue.length} · 加入 ${formatDate(entry.addedAt)}</p>
    <div class="review-card">
      <span class="review-type">${entry.type === "phrase" ? "固定词组" : "单词"}</span>
      <h2>${escapeHtml(entry.text)}</h2>
      ${state.reviewFlipped ? renderReviewBack(entry) : `<p class="empty">先回忆这个词的词源和当前语境义，再翻面。</p>`}
    </div>
    ${state.reviewFlipped ? renderReviewButtons() : `<button class="primary-btn add-word-btn" id="flipReviewBtn">显示答案</button>`}
  `;

  elements.detailDrawer.classList.add("open");
  elements.detailDrawer.setAttribute("aria-hidden", "false");

  const flipButton = document.querySelector("#flipReviewBtn");
  if (flipButton) {
    flipButton.addEventListener("click", () => {
      state.reviewFlipped = true;
      renderReviewCard();
    });
  }

  elements.detailContent.querySelectorAll("[data-review-grade]").forEach((button) => {
    button.addEventListener("click", () => gradeReview(button.dataset.reviewGrade));
  });
}

function renderReviewBack(entry) {
  return `
    <p><strong>词源说明：</strong>${escapeHtml(entry.rootAffix || "")}</p>
    <div class="semantic-chain">${renderSemanticChain(entry.semanticChain || [])}</div>
  `;
}

function renderReviewButtons() {
  return `
    <div class="review-actions">
      <button class="review-grade again" data-review-grade="again">忘记了</button>
      <button class="review-grade hard" data-review-grade="hard">困难</button>
      <button class="review-grade good" data-review-grade="good">记得</button>
      <button class="review-grade easy" data-review-grade="easy">简单</button>
    </div>
  `;
}

function gradeReview(grade) {
  const reviewed = state.reviewQueue[state.reviewIndex];
  const entry = findBookEntry(reviewed.id);
  if (entry) {
    scheduleEntry(entry, grade);
    saveBook();
  }

  state.reviewIndex += 1;
  state.reviewFlipped = false;
  renderReviewCard();
}

function scheduleEntry(entry, grade) {
  const now = new Date();
  const currentInterval = Number(entry.intervalDays || 0);
  const currentEase = Number(entry.ease || 2.5);
  let nextInterval = 1;
  let nextEase = currentEase;

  if (grade === "again") {
    nextInterval = 0;
    nextEase = Math.max(1.3, currentEase - 0.2);
    entry.lapses = Number(entry.lapses || 0) + 1;
  } else if (grade === "hard") {
    nextInterval = Math.max(1, Math.ceil(currentInterval * 1.2));
    nextEase = Math.max(1.3, currentEase - 0.15);
  } else if (grade === "good") {
    nextInterval = currentInterval ? Math.ceil(currentInterval * currentEase) : 1;
  } else {
    nextInterval = currentInterval ? Math.ceil(currentInterval * (currentEase + 1.1)) : 4;
    nextEase = currentEase + 0.15;
  }

  const dueAt = new Date(now);
  if (grade === "again") {
    dueAt.setMinutes(dueAt.getMinutes() + 10);
  } else {
    dueAt.setDate(dueAt.getDate() + nextInterval);
  }

  entry.intervalDays = nextInterval;
  entry.ease = Number(nextEase.toFixed(2));
  entry.reviews = Number(entry.reviews || 0) + 1;
  entry.lastReviewedAt = now.toISOString();
  entry.dueAt = dueAt.toISOString();
}

function getDueEntries() {
  const now = Date.now();
  return Object.values(state.book)
    .flatMap((group) => group.entries || [])
    .filter((entry) => new Date(entry.dueAt || entry.addedAt || Date.now()).getTime() <= now)
    .sort((a, b) => new Date(a.dueAt || a.addedAt).getTime() - new Date(b.dueAt || b.addedAt).getTime());
}

function findBookEntry(entryId) {
  for (const group of Object.values(state.book)) {
    const entry = group.entries?.find((item) => item.id === entryId);
    if (entry) return entry;
  }
  return null;
}

function migrateBook() {
  let changed = false;
  Object.values(state.book).forEach((group) => {
    (group.entries || []).forEach((entry) => {
      const addedAt = entry.addedAt || new Date().toISOString();
      const defaults = {
        addedAt,
        dueAt: entry.dueAt || addedAt,
        intervalDays: Number(entry.intervalDays || 0),
        ease: Number(entry.ease || 2.5),
        reviews: Number(entry.reviews || 0),
        lapses: Number(entry.lapses || 0),
        lastReviewedAt: entry.lastReviewedAt || null
      };
      Object.entries(defaults).forEach(([key, value]) => {
        if (entry[key] === undefined || entry[key] === null) {
          entry[key] = value;
          changed = true;
        }
      });
    });
  });
  if (changed) saveBook();
}

function getReviewStatus(entry) {
  const due = new Date(entry.dueAt || entry.addedAt || Date.now());
  const today = new Date();
  if (due.getTime() <= today.getTime()) return "今日复习";
  return `下次 ${formatDate(due.toISOString())}`;
}

function formatDate(value) {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function loadBook() {
  try {
    return JSON.parse(localStorage.getItem("readingAssistantBook") || "{}");
  } catch {
    return {};
  }
}

function saveBook() {
  localStorage.setItem("readingAssistantBook", JSON.stringify(state.book));
}

function formatUsage(usage) {
  const input = Number(usage?.inputTokens || 0);
  const cached = Number(usage?.cachedInputTokens || 0);
  const output = Number(usage?.outputTokens || 0);
  const total = Number(usage?.totalTokens || input + output);
  const cost = Number(usage?.estimatedCost || 0);
  const cachedText = cached ? `，缓存输入 ${cached.toLocaleString()}` : "";
  return `Token：输入 ${input.toLocaleString()}${cachedText}，输出 ${output.toLocaleString()}，合计 ${total.toLocaleString()}；估算 $${cost.toFixed(4)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
