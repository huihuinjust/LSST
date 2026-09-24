"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type StructureItem = { label: string; content: string };
type ScoringPoint = { label: string; points: number; answer_hint: string };
type Term = {
  id: string;
  term: string;
  catalog_term: string;
  section: string;
  chapter: string;
  term_type: string;
  definition: string;
  exam_note?: string | null;
  一句话理解: string;
  structure: StructureItem[];
  keywords: string[];
  memory_chain: string;
  recall_questions: string[];
  scoring_points: ScoringPoint[];
  review_level: number;
};
type Database = {
  meta: { total_terms?: number; generated_at?: string };
  terms: Term[];
};
type Progress = {
  mastery: number;
  attempts: number;
  nextReview: string;
  lastScore: number;
  lastStudied: string;
  independent: boolean;
};
type ProgressMap = Record<string, Progress>;
type View = "home" | "train" | "library" | "random" | "progress";
type RecallMark = "independent" | "hinted" | "missed";

const STORAGE_KEY = "lsst-history-progress-v1";
const TARGET_KEY = "lsst-daily-target-v1";

const todayKey = () => new Date().toISOString().slice(0, 10);
const addDays = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

function dueInterval(score: number) {
  if (score <= 3) return 0;
  if (score <= 5) return 1;
  if (score <= 7) return 3;
  if (score <= 9) return 7;
  return 15;
}

function phaseName(phase: number) {
  return ["理解", "骨架", "主动回忆", "核对得分", "完成"][phase] ?? "训练";
}

function priorityLabel(level: number) {
  if (level >= 5) return "核心必背";
  if (level >= 4) return "高频重点";
  if (level >= 3) return "常规掌握";
  return "拓展识记";
}

type ClozeSegment = { text: string; maskIndex: number | null };

const CLOZE_STOP_WORDS = new Set([
  "一个",
  "一些",
  "一种",
  "主要",
  "进行",
  "通过",
  "由于",
  "为了",
  "成为",
  "开始",
  "后来",
  "时期",
  "事件",
  "方面",
  "一定",
  "重要",
  "具有",
  "产生",
  "形成",
  "发展",
  "社会",
  "国家",
  "历史",
  "文化",
  "统治",
  "发现",
  "认为",
  "出现",
  "实行",
  "建立",
]);

function segmentChineseWords(text: string) {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
    return Array.from(segmenter.segment(text))
      .filter((item) => item.isWordLike)
      .map((item) => item.segment.trim())
      .filter(Boolean);
  }

  return text.match(/[A-Za-z]+|\d+(?:—\d+)?年?|[\u3400-\u9fff]{2,6}/g) ?? [];
}

function chooseClauseKeyword(clause: string, keywords: string[]) {
  const compactClause = clause.replace(/\s+/g, "");
  if (compactClause.length < 4) return "";

  const cleanKeywords = keywords
    .map((keyword) => keyword.replace(/[…·]+$/g, "").trim())
    .filter(Boolean);
  const keywordWords = new Set(
    cleanKeywords.flatMap((keyword) => segmentChineseWords(keyword)),
  );
  const candidates = new Set<string>();

  cleanKeywords.forEach((keyword) => {
    if (keyword.length >= 2 && keyword.length <= 8 && clause.includes(keyword)) {
      candidates.add(keyword);
    }
  });
  segmentChineseWords(clause).forEach((word) => candidates.add(word));

  const dates =
    clause.match(
      /(?:公元前|公元)?\d{2,4}(?:—(?:公元前|公元)?\d{2,4})?年|\d+余?年/g,
    ) ?? [];
  dates.forEach((date) => candidates.add(date));

  const titles = clause.match(/《[^》]{2,8}》/g) ?? [];
  titles.forEach((title) => candidates.add(title));

  return Array.from(candidates)
    .filter((candidate) => {
      const length = candidate.replace(/[《》“”]/g, "").length;
      if (length < 2 || length > 8 || CLOZE_STOP_WORDS.has(candidate)) return false;
      if (!clause.includes(candidate)) return false;
      return candidate.length / compactClause.length <= 0.55;
    })
    .map((candidate) => {
      let score = 0;
      if (
        cleanKeywords.some(
          (keyword) =>
            keyword.includes(candidate) ||
            (candidate.length >= 4 && candidate.includes(keyword)),
        )
      ) {
        score += 12;
      }
      if (keywordWords.has(candidate)) score += 6;
      if (/[0-9]/.test(candidate)) score += 8;
      if (/^《.*》$/.test(candidate)) score += 7;
      if (/^[\u3400-\u9fff]{2,6}$/.test(candidate)) score += 3;
      if (candidate.length >= 3 && candidate.length <= 6) score += 2;
      score += Math.min(clause.indexOf(candidate), 12) / 20;
      return { candidate, score };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.candidate.length - a.candidate.length ||
        clause.indexOf(a.candidate) - clause.indexOf(b.candidate),
    )[0]?.candidate ?? "";
}

function buildClozeSegments(text: string, keywords: string[]): ClozeSegment[] {
  const parts = text.split(/([，,。！？；;：:\n])/);
  const segments: ClozeSegment[] = [];
  let maskIndex = 0;

  parts.forEach((part) => {
    if (!part) return;
    if (/^[，,。！？；;：:\n]$/.test(part)) {
      segments.push({ text: part, maskIndex: null });
      return;
    }

    const keyword = chooseClauseKeyword(part, keywords);
    const keywordIndex = keyword ? part.indexOf(keyword) : -1;
    if (keywordIndex < 0) {
      segments.push({ text: part, maskIndex: null });
      return;
    }

    const before = part.slice(0, keywordIndex);
    const after = part.slice(keywordIndex + keyword.length);
    if (before) segments.push({ text: before, maskIndex: null });
    segments.push({ text: keyword, maskIndex });
    if (after) segments.push({ text: after, maskIndex: null });
    maskIndex += 1;
  });

  return segments;
}

function buildRecallParts(text: string) {
  const normalized = text.replace(/\s+/g, "").trim();
  if (!normalized) return [];

  const sentenceParts = normalized
    .split(/(?<=[。！？；;])/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (sentenceParts.length > 1) return sentenceParts;

  return normalized
    .split(/(?<=[，,])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function ClozeDefinition({
  text,
  keywords,
}: {
  text: string;
  keywords: string[];
}) {
  const [revealed, setRevealed] = useState<number[]>([]);
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const segments = useMemo(
    () => buildClozeSegments(text, keywords),
    [keywords, text],
  );

  useEffect(
    () => () => {
      Object.values(timers.current).forEach(clearTimeout);
    },
    [],
  );

  function revealMask(index: number) {
    setRevealed((current) =>
      current.includes(index) ? current : [...current, index],
    );
    clearTimeout(timers.current[index]);
    timers.current[index] = setTimeout(() => {
      setRevealed((current) => current.filter((item) => item !== index));
      delete timers.current[index];
    }, 3000);
  }

  return (
    <p className="cloze-text">
      {segments.map((segment, partIndex) => {
        if (segment.maskIndex === null) {
          return <span key={`text-${partIndex}`}>{segment.text}</span>;
        }
        const currentMask = segment.maskIndex;
        const isRevealed = revealed.includes(currentMask);
        return (
          <button
            type="button"
            key={`mask-${partIndex}`}
            className={isRevealed ? "cloze-mask revealed" : "cloze-mask"}
            aria-label={
              isRevealed
                ? `${segment.text}，3秒后重新遮挡`
                : "关键词已遮挡，点击显示3秒"
            }
            onClick={() => revealMask(currentMask)}
          >
            <span aria-hidden="true">{segment.text}</span>
          </button>
        );
      })}
    </p>
  );
}

export function HistoryTrainer() {
  const [terms, setTerms] = useState<Term[]>([]);
  const [progress, setProgress] = useState<ProgressMap>(() => {
    if (typeof window === "undefined") return {};
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  const [view, setView] = useState<View>("home");
  const [selectedId, setSelectedId] = useState("");
  const [phase, setPhase] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [section, setSection] = useState("全部");
  const [visibleLimit, setVisibleLimit] = useState(100);
  const [randomPartIndex, setRandomPartIndex] = useState(0);
  const [randomReturn, setRandomReturn] = useState(false);
  const [trainingReturnView, setTrainingReturnView] = useState<Exclude<View, "train">>("home");
  const [trainingReturnScrollY, setTrainingReturnScrollY] = useState(0);
  const [expandedBranch, setExpandedBranch] = useState<number | null>(0);
  const [revealedHints, setRevealedHints] = useState<number[]>([]);
  const [marks, setMarks] = useState<Record<number, RecallMark>>({});
  const [dailyTarget, setDailyTarget] = useState(() => {
    if (typeof window === "undefined") return 10;
    const target = Number(localStorage.getItem(TARGET_KEY));
    return target >= 5 && target <= 50 ? target : 10;
  });
  const [toast, setToast] = useState("");
  const [resultSaved, setResultSaved] = useState(false);

  useEffect(() => {
    fetch("/data/history_terms_database.json")
      .then((response) => {
        if (!response.ok) throw new Error("数据库加载失败");
        return response.json() as Promise<Database>;
      })
      .then((data) => {
        setTerms(data.terms);
        setSelectedId(data.terms[0]?.id ?? "");
      })
      .catch(() => setLoadError("名词数据库没有成功加载，请刷新页面重试。"))
      .finally(() => setLoading(false));

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  const selected = useMemo(
    () => terms.find((term) => term.id === selectedId) ?? terms[0],
    [selectedId, terms],
  );
  const randomParts = useMemo(
    () => (selected ? buildRecallParts(selected.definition) : []),
    [selected],
  );

  const dueTerms = useMemo(
    () =>
      terms.filter((term) => {
        const item = progress[term.id];
        return item && item.nextReview <= todayKey();
      }),
    [progress, terms],
  );

  const newTerms = useMemo(
    () => terms.filter((term) => !progress[term.id]),
    [progress, terms],
  );

  const studiedToday = useMemo(
    () =>
      Object.values(progress).filter((item) => item.lastStudied === todayKey())
        .length,
    [progress],
  );

  const mastered = useMemo(
    () => Object.values(progress).filter((item) => item.mastery >= 80).length,
    [progress],
  );

  const matchingTerms = useMemo(() => {
    const query = search.trim().toLowerCase();
    return terms
      .filter((term) => section === "全部" || term.section === section)
      .filter(
        (term) =>
          !query ||
          term.term.toLowerCase().includes(query) ||
          term.chapter.toLowerCase().includes(query) ||
          term.keywords.some((keyword) => keyword.toLowerCase().includes(query)),
      );
  }, [search, section, terms]);

  const filteredTerms = useMemo(
    () => matchingTerms.slice(0, visibleLimit),
    [matchingTerms, visibleLimit],
  );

  const recommendationAnchor = useMemo(() => {
    const studiedIds = Object.keys(progress);
    for (let index = studiedIds.length - 1; index >= 0; index -= 1) {
      const term = terms.find((item) => item.id === studiedIds[index]);
      if (term) return term;
    }
    return null;
  }, [progress, terms]);

  const relatedTerms = useMemo(() => {
    if (!recommendationAnchor) return newTerms.slice(0, 3);

    const sameChapter = terms.filter(
      (term) =>
        term.id !== recommendationAnchor.id &&
        term.chapter === recommendationAnchor.chapter,
    );
    const sameType = terms.filter(
      (term) =>
        term.id !== recommendationAnchor.id &&
        term.chapter !== recommendationAnchor.chapter &&
        term.term_type === recommendationAnchor.term_type,
    );
    return [...sameChapter, ...sameType]
      .filter(
        (term, index, items) =>
          items.findIndex((item) => item.id === term.id) === index,
      )
      .slice(0, 3);
  }, [newTerms, recommendationAnchor, terms]);

  const score = useMemo(() => {
    if (!selected) return 0;
    return Math.round(
      selected.scoring_points.reduce((total, point, index) => {
        if (marks[index] === "independent") return total + point.points;
        if (marks[index] === "hinted") return total + point.points * 0.6;
        return total;
      }, 0),
    );
  }, [marks, selected]);

  function saveProgress(next: ProgressMap) {
    setProgress(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  function openTraining(term: Term, returnToRandom = false) {
    setTrainingReturnView(returnToRandom ? "random" : view === "library" ? "library" : "home");
    setTrainingReturnScrollY(window.scrollY);
    setSelectedId(term.id);
    setPhase(0);
    setExpandedBranch(0);
    setRevealedHints([]);
    setMarks({});
    setResultSaved(false);
    setRandomReturn(returnToRandom);
    setView("train");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function leaveTraining() {
    const destination = trainingReturnView;
    const scrollY = trainingReturnScrollY;
    setView(destination);
    window.setTimeout(() => window.scrollTo({ top: scrollY, behavior: "auto" }), 0);
  }

  function startRandomRecitation(excludeId?: string) {
    const pool = terms.filter((term) => term.id !== excludeId);
    const next = pool[Math.floor(Math.random() * pool.length)] ?? terms[0];
    if (!next) return;
    setSelectedId(next.id);
    setRandomPartIndex(0);
    setRandomReturn(false);
    setView("random");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startRecommended() {
    const candidates = dueTerms.length ? dueTerms : newTerms;
    const term = candidates[0] ?? terms[0];
    if (term) openTraining(term);
  }

  function completeTraining() {
    if (!selected || resultSaved) return;
    const previous = progress[selected.id];
    const next: ProgressMap = {
      ...progress,
      [selected.id]: {
        mastery: Math.max(previous?.mastery ?? 0, score * 10),
        attempts: (previous?.attempts ?? 0) + 1,
        nextReview: addDays(dueInterval(score)),
        lastScore: score,
        lastStudied: todayKey(),
        independent: score === 10 && !Object.values(marks).includes("hinted"),
      },
    };
    saveProgress(next);
    setResultSaved(true);
    setToast(`已记录 ${score} 分，下次复习：${next[selected.id].nextReview}`);
    setTimeout(() => setToast(""), 2600);
  }

  function chooseNext() {
    const pool = dueTerms.filter((term) => term.id !== selected?.id);
    const fallback = newTerms.filter((term) => term.id !== selected?.id);
    const next = pool[0] ?? fallback[0] ?? terms[0];
    if (next) openTraining(next);
  }

  if (loading) {
    return (
      <main className="app-shell loading-screen">
        <div className="seal">史</div>
        <p>正在展开历史长卷…</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="app-shell loading-screen">
        <div className="seal">!</div>
        <h1>暂时无法进入记忆室</h1>
        <p>{loadError}</p>
        <button className="primary-button" onClick={() => location.reload()}>
          重新加载
        </button>
      </main>
    );
  }

  return (
    <main className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      {view !== "train" && (
        <header className="topbar">
          <div>
            <p className="eyebrow">NNU · 841 中国历史</p>
            <h1>历史记忆室</h1>
          </div>
          <div className="streak" aria-label="今日完成数">
            <span>今</span>
            <strong>{studiedToday}</strong>
          </div>
        </header>
      )}

      {view === "home" && (
        <section className="page">
          <div className="hero-card">
            <div className="hero-copy">
              <p className="small-label">今日进度</p>
              <h2>
                先记住骨架，
                <br />
                再让细节归位。
              </h2>
              <p>
                今日已完成 {studiedToday} / {dailyTarget} 个名词
              </p>
            </div>
            <div className="progress-ring" style={{ "--progress": `${Math.min(100, (studiedToday / dailyTarget) * 100)}%` } as React.CSSProperties}>
              <div>
                <strong>{Math.round(Math.min(100, (studiedToday / dailyTarget) * 100))}%</strong>
                <span>今日</span>
              </div>
            </div>
          </div>

          <div className="status-grid">
            <div className="status-card">
              <span className="status-icon red">复</span>
              <strong>{dueTerms.length}</strong>
              <small>待复习</small>
            </div>
            <div className="status-card">
              <span className="status-icon blue">新</span>
              <strong>{newTerms.length}</strong>
              <small>未学习</small>
            </div>
            <div className="status-card">
              <span className="status-icon gold">熟</span>
              <strong>{mastered}</strong>
              <small>已掌握</small>
            </div>
          </div>

          <button className="primary-button large" onClick={startRecommended}>
            <span>{dueTerms.length ? "开始今日复习" : "学习一个新名词"}</span>
            <b>→</b>
          </button>

          <div className="section-heading">
            <div>
              <p className="small-label">关联知识点</p>
              <h3>
                {recommendationAnchor
                  ? `围绕“${recommendationAnchor.term}”串联`
                  : "按目录从头建立知识网"}
              </h3>
            </div>
            <button onClick={() => setView("library")}>查看全部</button>
          </div>

          <div className="recommend-list">
            {relatedTerms.map((term) => (
                <button
                  className="term-row"
                  key={term.id}
                  onClick={() => openTraining(term)}
                >
                  <span className="term-monogram">{term.term.slice(0, 1)}</span>
                  <span className="term-row-copy">
                    <strong>{term.term}</strong>
                    <small>
                      {term.section} · {term.chapter.replace(/^第.+章\s*/, "")}
                    </small>
                  </span>
                  <span className="priority">{priorityLabel(term.review_level)}</span>
                </button>
              ))}
          </div>

          <div className="method-card">
            <span className="method-mark">忆</span>
            <div>
              <strong>这不是“再看一遍”</strong>
              <p>理解 → 骨架 → 遮住答案回忆 → 按得分点核对，才会形成可提取的记忆。</p>
            </div>
          </div>
        </section>
      )}

      {view === "train" && selected && (
        <section className="page training-page">
          <div className="training-head">
            <button
              className="round-button"
              onClick={leaveTraining}
              aria-label="退出训练"
            >
              ←
            </button>
            <div>
              <small>第 {phase + 1} 步 / 5</small>
              <strong>{phaseName(phase)}</strong>
            </div>
            <span className="priority solid">{priorityLabel(selected.review_level)}</span>
          </div>

          <div className="phase-track" aria-label={`当前阶段：${phaseName(phase)}`}>
            {[0, 1, 2, 3, 4].map((item) => (
              <span key={item} className={item <= phase ? "active" : ""} />
            ))}
          </div>

          <article className="term-title-card">
            <p className="term-context">
              {selected.section} · {selected.chapter}
            </p>
            <h2>{selected.term}</h2>
            <div className="keyword-row">
              {selected.keywords.slice(0, 4).map((keyword) => (
                <span key={keyword}>{keyword}</span>
              ))}
            </div>
            {selected.exam_note && (
              <div className="term-note-row">
                <span className="term-note-label">真题出处</span>
                <span className="term-note-content">{selected.exam_note}</span>
              </div>
            )}
          </article>

          {phase === 0 && (
            <>
              <section className="content-card definition-card">
                <p className="card-kicker">完整释义原文</p>
                <p className="definition-text">{selected.definition}</p>
              </section>

              <section className="content-card mindmap-card">
                <div className="card-title-line">
                  <div>
                    <p className="card-kicker">理解思维导图</p>
                    <h3>先看关系，再记内容</h3>
                  </div>
                  <span>点击分支</span>
                </div>
                <div className="mindmap">
                  <div className="mindmap-root">{selected.term}</div>
                  <div className="mindmap-trunk" />
                  <div className="mindmap-branches">
                    {selected.structure.map((item, index) => (
                      <button
                        key={`${item.label}-${index}`}
                        className={expandedBranch === index ? "branch open" : "branch"}
                        onClick={() =>
                          setExpandedBranch(expandedBranch === index ? null : index)
                        }
                      >
                        <span className="branch-index">{index + 1}</span>
                        <span>
                          <strong>{item.label}</strong>
                          {expandedBranch === index && <small>{item.content}</small>}
                        </span>
                        <b>{expandedBranch === index ? "−" : "+"}</b>
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              <section className="content-card understanding">
                <p className="card-kicker">一句话抓住本质</p>
                <p className="lead-sentence">{selected.一句话理解}</p>
              </section>
            </>
          )}

          {phase === 1 && (
            <>
              <section className="content-card chain-card">
                <p className="card-kicker">答题骨架</p>
                <h3>把整段压成一条可行走的路</h3>
                <div className="chain-flow">
                  {selected.structure.map((item, index) => (
                    <div className="chain-step" key={`${item.label}-${index}`}>
                      <span>{index + 1}</span>
                      <div>
                        <strong>{item.label}</strong>
                        <p>{item.content}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
              <section className="content-card memory-line">
                <p className="card-kicker">记忆串联</p>
                <p>{selected.memory_chain}</p>
              </section>
              <section className="content-card cloze-card">
                <div className="card-title-line">
                  <div>
                    <p className="card-kicker">原文关键词遮挡</p>
                    <h3>沿着骨架，把关键词填回来</h3>
                  </div>
                  <span>点击显示 3 秒</span>
                </div>
                <ClozeDefinition
                  key={selected.id}
                  text={selected.definition}
                  keywords={selected.keywords}
                />
              </section>
              <div className="tip-box">
                <span>诀</span>
                <p>先只复述每个分支的标题；顺序正确后，再把内容挂回标题下面。</p>
              </div>
            </>
          )}

          {phase === 2 && (
            <>
              <section className="recall-intro">
                <span>遮</span>
                <div>
                  <h3>现在不要往回看</h3>
                  <p>先在心里或纸上作答，卡住时再逐级揭示提示。</p>
                </div>
              </section>
              <div className="question-list">
                {selected.recall_questions.map((question, index) => (
                  <article className="question-card" key={question}>
                    <div className="question-number">问 {index + 1}</div>
                    <h3>{question}</h3>
                    <textarea
                      aria-label={`第${index + 1}题作答区`}
                      placeholder="可以在这里输入，也可以直接口述或默写…"
                      rows={4}
                    />
                    {revealedHints.includes(index) ? (
                      <div className="hint-answer">
                        <span>提示</span>
                        <p>{selected.structure[index]?.content ?? selected.keywords.join("、")}</p>
                      </div>
                    ) : (
                      <button
                        className="ghost-button"
                        onClick={() => setRevealedHints([...revealedHints, index])}
                      >
                        卡住了，给一点提示
                      </button>
                    )}
                  </article>
                ))}
              </div>
            </>
          )}

          {phase === 3 && (
            <>
              <section className="score-header">
                <p className="card-kicker">对照采分点</p>
                <h3>不是“看着眼熟”，而是检查能否独立写出</h3>
                <div className="live-score">
                  <strong>{score}</strong>
                  <span>/ 10 分</span>
                </div>
              </section>
              <div className="score-list">
                {selected.scoring_points.map((point, index) => {
                  const mark = marks[index] ?? "missed";
                  return (
                    <article className="score-card" key={`${point.label}-${index}`}>
                      <div className="score-card-head">
                        <strong>{point.label}</strong>
                        <span>{point.points} 分</span>
                      </div>
                      <p>{point.answer_hint}</p>
                      <div className="mark-group">
                        {([
                          ["independent", "独立写出"],
                          ["hinted", "提示后想起"],
                          ["missed", "遗漏"],
                        ] as [RecallMark, string][]).map(([value, label]) => (
                          <button
                            key={value}
                            className={mark === value ? `selected ${value}` : ""}
                            onClick={() => setMarks({ ...marks, [index]: value })}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}

          {phase === 4 && (
            <section className="finish-card">
              <div className="result-seal">{score}</div>
              <p className="card-kicker">本次回忆得分</p>
              <h2>
                {score >= 9
                  ? "已经能稳稳提取"
                  : score >= 7
                    ? "骨架已成，再补细节"
                    : score >= 4
                      ? "有印象，还需要主动提取"
                      : "别急，先把骨架走顺"}
              </h2>
              <p>
                {score >= 9
                  ? "下一次会拉开复习间隔，检验它能否进入长期记忆。"
                  : "短间隔再见一次，优先修补刚才遗漏的采分点。"}
              </p>
              <div className="result-meta">
                <span>下次复习</span>
                <strong>{addDays(dueInterval(score))}</strong>
              </div>
              <button
                className="primary-button large"
                onClick={completeTraining}
                disabled={resultSaved}
              >
                {resultSaved ? "本次结果已保存" : "保存本次结果"}
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  completeTraining();
                  if (randomReturn) {
                    startRandomRecitation(selected.id);
                  } else {
                    chooseNext();
                  }
                }}
              >
                {randomReturn ? "保存后下一个随机名词" : "保存后继续下一个"}
              </button>
            </section>
          )}

          {phase < 4 && (
            <div className="training-actions">
              {phase > 0 && (
                <button className="secondary-button" onClick={() => setPhase(phase - 1)}>
                  上一步
                </button>
              )}
              <button className="primary-button" onClick={() => setPhase(phase + 1)}>
                {phase === 2 ? "完成回忆，核对答案" : "继续"}
              </button>
            </div>
          )}
        </section>
      )}

      {view === "random" && selected && (
        <section className="page random-page">
          <div className="page-heading">
            <p className="eyebrow">随机主动回忆</p>
            <h2>不按顺序，检验能否提取</h2>
            <p>每次只看一个分句，背好后再打开下一个。</p>
          </div>
          <article className="random-term-card">
            <div className="random-term-meta">
              <span>{selected.section} · {selected.chapter}</span>
              <b>{priorityLabel(selected.review_level)}</b>
            </div>
            <h3>{selected.term}</h3>
            <div className="random-progress" aria-label={`第 ${randomPartIndex + 1} 句，共 ${randomParts.length} 句`}>
              {randomParts.map((_, index) => (
                <span key={index} className={index <= randomPartIndex ? "active" : ""} />
              ))}
            </div>
          </article>

          <section className="random-recall-card">
            <div className="random-recall-head">
              <span>第 {randomPartIndex + 1} 句 / {randomParts.length || 1}</span>
              <span>主动回忆</span>
            </div>
            <p className="random-recall-text">
              {randomParts.slice(0, randomPartIndex + 1).map((part, index) => (
                <span key={`${selected.id}-recall-part-${index}`}>{part}</span>
              ))}
            </p>
            <p className="random-recall-tip">
              先复述目前显示的内容，再决定是否打开下一句。
            </p>
          </section>

          <div className="random-actions">
            <button
              className="secondary-button"
              disabled={randomPartIndex === 0}
              onClick={() => setRandomPartIndex((current) => Math.max(0, current - 1))}
            >
              上一句
            </button>
            <button
              className="primary-button"
              onClick={() => {
                if (randomPartIndex < randomParts.length - 1) {
                  setRandomPartIndex((current) => current + 1);
                } else {
                  startRandomRecitation(selected.id);
                }
              }}
            >
              {randomPartIndex < randomParts.length - 1 ? "下一句" : "下一个随机名词"}
            </button>
            <button
              className="secondary-button random-assist-button"
              onClick={() => openTraining(selected, true)}
            >
              助记
            </button>
          </div>
        </section>
      )}

      {view === "library" && (
        <section className="page">
          <div className="page-heading">
            <p className="eyebrow">{terms.length} 个目录名词</p>
            <h2>名词库</h2>
            <p>只收录目录中的考点，可按篇章或关键词快速定位。</p>
          </div>
          <button
            type="button"
            className="random-launch"
            onClick={() => startRandomRecitation()}
          >
            <span className="random-launch-icon">↗</span>
            <span>
              <strong>随机背诵</strong>
              <small>从 947 个名词中随机抽取一条</small>
            </span>
            <b>开始</b>
          </button>
          <label className="search-box">
            <span>⌕</span>
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setVisibleLimit(100);
              }}
              placeholder="搜索名词、章节或关键词"
            />
          </label>
          <div className="filter-tabs">
            {["全部", "中国古代史", "中国近现代史"].map((item) => (
              <button
                key={item}
                className={section === item ? "active" : ""}
                onClick={() => {
                  setSection(item);
                  setVisibleLimit(100);
                }}
              >
                {item === "全部" ? "全部" : item.replace("中国", "")}
              </button>
            ))}
          </div>
          <p className="result-count">
            已按目录顺序显示 {filteredTerms.length} / {matchingTerms.length} 个
          </p>
          <div className="library-list">
            {filteredTerms.map((term) => {
              const item = progress[term.id];
              return (
                <button key={term.id} onClick={() => openTraining(term)}>
                  <span className="term-monogram">{term.term.slice(0, 1)}</span>
                  <span>
                    <strong>{term.term}</strong>
                    <small>{term.chapter}</small>
                    <em>{term.一句话理解}</em>
                  </span>
                  <i className={item ? "done" : ""}>
                    {item ? `${item.lastScore}分` : "未学"}
                  </i>
                </button>
              );
            })}
          </div>
          {filteredTerms.length < matchingTerms.length && (
            <button
              type="button"
              className="load-more-button"
              onClick={() => setVisibleLimit((current) => current + 100)}
            >
              再加载 {Math.min(100, matchingTerms.length - filteredTerms.length)} 个
              <span>剩余 {matchingTerms.length - filteredTerms.length} 个</span>
            </button>
          )}
        </section>
      )}

      {view === "progress" && (
        <section className="page">
          <div className="page-heading">
            <p className="eyebrow">只和昨天的自己比较</p>
            <h2>学习进度</h2>
            <p>考试优先级来自题目特点，掌握度来自你的真实回忆表现。</p>
          </div>
          <div className="progress-overview">
            <div>
              <small>已学习</small>
              <strong>{Object.keys(progress).length}</strong>
              <span>/ {terms.length}</span>
            </div>
            <div>
              <small>掌握率</small>
              <strong>
                {Object.keys(progress).length
                  ? Math.round((mastered / Object.keys(progress).length) * 100)
                  : 0}
              </strong>
              <span>%</span>
            </div>
          </div>
          <section className="content-card settings-card">
            <div>
              <p className="card-kicker">每日目标</p>
              <h3>{dailyTarget} 个名词</h3>
            </div>
            <input
              type="range"
              min="5"
              max="30"
              step="5"
              value={dailyTarget}
              onChange={(event) => {
                const value = Number(event.target.value);
                setDailyTarget(value);
                localStorage.setItem(TARGET_KEY, String(value));
              }}
            />
            <p>建议从 10 个开始，稳定完成比一口气刷很多更重要。</p>
          </section>
          <section className="content-card">
            <div className="card-title-line">
              <div>
                <p className="card-kicker">复习队列</p>
                <h3>间隔由每次得分决定</h3>
              </div>
            </div>
            <div className="schedule-list">
              {[
                ["0–3 分", "当天再见"],
                ["4–5 分", "1 天后"],
                ["6–7 分", "3 天后"],
                ["8–9 分", "7 天后"],
                ["10 分且无提示", "15 天后"],
              ].map(([range, interval]) => (
                <div key={range}>
                  <strong>{range}</strong>
                  <span>{interval}</span>
                </div>
              ))}
            </div>
          </section>
          <button
            className="danger-link"
            onClick={() => {
              if (confirm("确定清空这台设备上的全部学习记录吗？")) {
                saveProgress({});
              }
            }}
          >
            清空本机学习记录
          </button>
        </section>
      )}

      {view !== "train" && (
        <nav className="bottom-nav" aria-label="主导航">
          {([
            ["home", "⌂", "今日"],
            ["library", "册", "名词库"],
            ["progress", "◔", "进度"],
          ] as [View, string, string][]).map(([target, icon, label]) => (
            <button
              key={target}
              className={view === target ? "active" : ""}
              onClick={() => setView(target)}
            >
              <span>{icon}</span>
              <small>{label}</small>
            </button>
          ))}
        </nav>
      )}
    </main>
  );
}
