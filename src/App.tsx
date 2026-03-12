import { useState, useCallback, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ─── Types ───────────────────────────────────────────────────────────────────

interface Assessment {
  id: number;
  name: string;
  type: "assignment" | "quiz" | "exam" | "project" | "participation" | "other";
  weight: number;
  maxMark: number;
  dueDate: string;
  hurdleMark?: number; // minimum raw mark required to pass the subject
}

interface ParsedResponse {
  subject: string;
  assessments: Assessment[];
}

interface Grade {
  label: string;
  name: string;
  min: number;
  color: string;
  bg: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const GRADES: Grade[] = [
  { label: "HD", name: "High Distinction", min: 85, color: "#00C896", bg: "rgba(0,200,150,0.12)" },
  { label: "D",  name: "Distinction",      min: 75, color: "#4DA6FF", bg: "rgba(77,166,255,0.12)" },
  { label: "CR", name: "Credit",           min: 65, color: "#A78BFA", bg: "rgba(167,139,250,0.12)" },
  { label: "P",  name: "Pass",             min: 50, color: "#FBBF24", bg: "rgba(251,191,36,0.12)" },
  { label: "F",  name: "Fail",             min: 0,  color: "#F87171", bg: "rgba(248,113,113,0.12)" },
];

const typeColors: Record<string, string> = {
  assignment: "#4DA6FF",
  quiz: "#A78BFA",
  exam: "#F87171",
  project: "#00C896",
  participation: "#FBBF24",
  other: "#94A3B8",
};

type Step = "upload" | "loading" | "calc" | "error";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parses raw PDF bytes to extract visible text strings, returned as markdown. */
function extractRawPDFMarkdown(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // Decode as latin-1 to preserve byte values
  let raw = "";
  for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);

  const lines: string[] = [];

  // Extract text between BT...ET operators
  const btBlocks = raw.match(/BT[\s\S]*?ET/g) ?? [];
  for (const block of btBlocks) {
    // Literal strings: (text)
    const literals = block.match(/\(([^)\\]*(?:\\.[^)\\]*)*)\)/g) ?? [];
    for (const lit of literals) {
      const inner = lit.slice(1, -1)
        .replace(/\\n/g, "\n").replace(/\\r/g, "\n")
        .replace(/\\t/g, " ").replace(/\\\(/g, "(").replace(/\\\)/g, ")")
        .replace(/\\\\/g, "\\");
      const text = inner.replace(/[^\x20-\x7E\n]/g, "").trim();
      if (text.length > 1) lines.push(text);
    }
    // Hex strings: <4865...>
    const hexStrings = block.match(/<[0-9A-Fa-f]+>/g) ?? [];
    for (const hex of hexStrings) {
      const h = hex.slice(1, -1);
      let text = "";
      for (let i = 0; i + 1 < h.length; i += 2)
        text += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
      const clean = text.replace(/[^\x20-\x7E]/g, "").trim();
      if (clean.length > 1) lines.push(clean);
    }
  }

  if (lines.length === 0) return "";

  // Simple markdown: group consecutive short tokens into paragraphs
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (line.length < 4 && /^[\d.]+$/.test(line)) {
      // Likely a number — treat as inline
      current += (current ? " " : "") + line;
    } else if (line.length > 60) {
      if (current) { chunks.push(current); current = ""; }
      chunks.push(line);
    } else {
      current += (current ? " " : "") + line;
      if (current.length > 120) { chunks.push(current); current = ""; }
    }
  }
  if (current) chunks.push(current);

  return chunks.join("\n\n");
}

function getGradeLabel(score: number): Grade {
  for (const g of GRADES) {
    if (score >= g.min) return g;
  }
  return GRADES[4];
}

function parseAssessments(raw: string): Assessment[] {
  try {
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    const jsonStr = jsonMatch ? jsonMatch[1] : raw;
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : parsed.assessments || [];
  } catch {
    return [];
  }
}

// ─── Shared AI prompt ────────────────────────────────────────────────────────

const PROMPT = `You are an academic assistant. Extract ALL assessments/assignments/quizzes/exams and the subject/course name.

Return ONLY a valid JSON object (no markdown, no explanation) with this exact structure:
{
  "subject": "Subject Name Here",
  "assessments": [
    {
      "name": "Assessment name",
      "type": "assignment|quiz|exam|project|participation|other",
      "weight": 30,
      "maxMark": 100,
      "dueDate": "Week 5 / 15 Mar 2025 / null if not found"
    }
  ]
}

Rules:
- weight is the percentage of final grade (must sum to ~100)
- maxMark is the maximum raw score (default 100 if not specified)
- Include every gradeable component
- Do not include non-graded activities`;

// ─── Icons ───────────────────────────────────────────────────────────────────

function UploadIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      style={{ animation: "spin 1s linear infinite" }}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function WAMCalculator() {
  const [step, setStep] = useState<Step>("upload");
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [marks, setMarks] = useState<Record<number, string>>({});
  const [completed, setCompleted] = useState<Record<number, boolean>>({});
  const [subjectName, setSubjectName] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [dragOver, setDragOver] = useState<boolean>(false);
  const [loadingMsg, setLoadingMsg] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(async (file: File) => {
    setStep("loading");
    setError("");
    try {
      console.log("[WAMcalc] Processing file:", file.name, file.type, file.size, "bytes");
      let response!: Response;
      const groqFetch = (body: object) =>
        fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${import.meta.env.VITE_GROQ_API_KEY as string}`,
          },
          body: JSON.stringify({ temperature: 0, ...body }),
        });

      // ── Image files → vision model ───────────────────────────────────────────
      if (file.type.startsWith("image/")) {
        setLoadingMsg("Reading image…");
        const b64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        setLoadingMsg("Extracting grade components with AI vision…");
        console.log("[WAMcalc] Sending image to Groq vision");
        response = await groqFetch({
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${file.type};base64,${b64}` } },
              { type: "text", text: `${PROMPT}\n\nAnalyse the subject outline image above.` },
            ],
          }],
        });

      // ── Text / Markdown / HTML files → text model ────────────────────────────
      } else if (
        file.type.startsWith("text/") ||
        file.name.endsWith(".txt") ||
        file.name.endsWith(".md") ||
        file.name.endsWith(".html")
      ) {
        setLoadingMsg("Reading file…");
        const fileText = await file.text();
        if (fileText.trim().length < 30) throw new Error("The file appears to be empty or too short.");
        setLoadingMsg("Extracting grade components with AI…");
        console.log("[WAMcalc] Sending text file to Groq, length:", fileText.length);
        response = await groqFetch({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: `${PROMPT}\n\nSubject outline:\n${fileText.slice(0, 12000)}` }],
        });

      // ── PDF files → PDF.js text → vision → raw binary markdown ──────────────
      } else if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
        setLoadingMsg("Reading PDF…");
        const arrayBuffer = await file.arrayBuffer();
        const arrayBufferCopy = arrayBuffer.slice(0);
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        console.log("[WAMcalc] PDF loaded, pages:", pdf.numPages);
        const pages = await Promise.all(
          Array.from({ length: pdf.numPages }, (_, i) =>
            pdf.getPage(i + 1)
              .then(p => p.getTextContent())
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .then(tc => tc.items.map((item: any) => item.str ?? "").join(" "))
          )
        );
        const pdfText = pages.join("\n").replace(/\s+/g, " ").trim();
        console.log("[WAMcalc] Extracted text length:", pdfText.length, "| Preview:", pdfText.slice(0, 200));

        if (pdfText.length >= 30) {
          setLoadingMsg("Extracting grade components with AI…");
          response = await groqFetch({
            model: "llama-3.3-70b-versatile",
            messages: [{ role: "user", content: `${PROMPT}\n\nSubject outline text:\n${pdfText.slice(0, 12000)}` }],
          });
        } else {
          // Fallback 1: vision (max 5 pages)
          const VISION_IMAGE_LIMIT = 5;
          let visionOk = false;
          if (pdf.numPages <= VISION_IMAGE_LIMIT) {
            try {
              setLoadingMsg("No text found — rendering pages for visual analysis…");
              const images: string[] = [];
              for (let i = 1; i <= pdf.numPages; i++) {
                setLoadingMsg(`Rendering page ${i} of ${pdf.numPages}…`);
                const page = await pdf.getPage(i);
                const viewport = page.getViewport({ scale: 1.5 });
                const canvas = document.createElement("canvas");
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
                images.push(canvas.toDataURL("image/jpeg", 0.75).split(",")[1]);
              }
              setLoadingMsg("Extracting grade components with AI vision…");
              response = await groqFetch({
                model: "meta-llama/llama-4-scout-17b-16e-instruct",
                messages: [{
                  role: "user",
                  content: [
                    ...images.map(b64 => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } })),
                    { type: "text", text: `${PROMPT}\n\nAnalyse the subject outline slides above.` },
                  ],
                }],
              });
              visionOk = true;
            } catch (visionErr) {
              console.warn("[WAMcalc] Vision fallback failed:", visionErr);
            }
          } else {
            console.log("[WAMcalc] PDF has", pdf.numPages, "pages — skipping vision, using markdown extraction");
          }

          // Fallback 2: raw binary → markdown
          if (!visionOk) {
            setLoadingMsg("Attempting raw PDF text extraction…");
            const markdown = extractRawPDFMarkdown(arrayBufferCopy);
            console.log("[WAMcalc] Raw markdown length:", markdown.length, "| Preview:", markdown.slice(0, 200));
            if (markdown.length < 30) throw new Error("Could not extract any readable text from this PDF.");
            setLoadingMsg("Extracting grade components with AI (markdown fallback)…");
            response = await groqFetch({
              model: "llama-3.3-70b-versatile",
              messages: [{ role: "user", content: `${PROMPT}\n\nSubject outline (extracted as markdown):\n${markdown.slice(0, 12000)}` }],
            });
          }
        }

      // ── Unknown — try reading as text ────────────────────────────────────────
      } else {
        setLoadingMsg("Reading file…");
        const fileText = await file.text().catch(() => "");
        if (fileText.trim().length < 30) throw new Error(`Unsupported file type "${file.type || file.name}". Please upload a PDF, image, or text file.`);
        setLoadingMsg("Extracting grade components with AI…");
        response = await groqFetch({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: `${PROMPT}\n\nSubject outline:\n${fileText.slice(0, 12000)}` }],
        });
      }

      // ── Parse response ───────────────────────────────────────────────────────
      const data = await response.json();
      console.log("[WAMcalc] Groq response status:", response.status, "| data:", data);
      if (!response.ok) throw new Error(data.error?.message || "API error");

      const aiText: string = data.choices?.[0]?.message?.content ?? "";
      const clean = aiText.replace(/```json|```/g, "").trim();

      let parsed: ParsedResponse;
      try {
        parsed = JSON.parse(clean) as ParsedResponse;
      } catch {
        const arr = parseAssessments(aiText);
        parsed = { subject: "", assessments: arr };
      }

      const items: Assessment[] = (parsed.assessments || []).map((a, i) => ({
        ...a,
        id: i,
        weight: Number(a.weight) || 0,
        maxMark: Number(a.maxMark) || 100,
      }));

      if (!items.length) throw new Error("No assessments found. Please ensure your file contains grade allocations.");

      setSubjectName(parsed.subject || file.name.replace(/\.[^.]+$/, ""));
      setAssessments(items);
      setMarks(Object.fromEntries(items.map(a => [a.id, ""])));
      setCompleted(Object.fromEntries(items.map(a => [a.id, false])));
      setStep("calc");
    } catch (e) {
      console.error("[WAMcalc] Error processing file:", e);
      setError((e as Error).message || "Something went wrong.");
      setStep("error");
    }
  }, []);

  const handleFile = (file: File | null | undefined) => {
    if (!file) {
      setError("No file selected.");
      setStep("error");
      return;
    }
    processFile(file);
  };

  // ─── WAM Calculations ───────────────────────────────────────────────────────

  const totalWeight = assessments.reduce((s, a) => s + a.weight, 0);
  const completedWeight = assessments.filter(a => completed[a.id]).reduce((s, a) => s + a.weight, 0);
  const remainingWeight = totalWeight - completedWeight;

  const currentWeighted = assessments.reduce((s, a) => {
    if (!completed[a.id]) return s;
    const raw = parseFloat(marks[a.id]);
    if (isNaN(raw)) return s;
    return s + (raw / a.maxMark) * a.weight;
  }, 0);

  const projectedFinal: number | null = completedWeight > 0 ? currentWeighted : null;
  const currentGrade: Grade | null = projectedFinal !== null ? getGradeLabel(projectedFinal) : null;

  // Hurdle detection: find any completed assessment where the mark is below the required minimum
  const failedHurdles = assessments.filter(a => {
    if (!a.hurdleMark || !completed[a.id]) return false;
    const raw = parseFloat(marks[a.id]);
    return !isNaN(raw) && raw < a.hurdleMark;
  });
  const isTechnicalFail = failedHurdles.length > 0;

  function neededForGrade(targetMin: number): number {
    return (targetMin - currentWeighted) / remainingWeight * 100;
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0B0F1A",
      fontFamily: "'DM Mono', 'Courier New', monospace",
      color: "#E2E8F0",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeUp { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:translateY(0); } }
        .upload-zone:hover { border-color: #4DA6FF !important; background: rgba(77,166,255,0.05) !important; }
        .mark-input { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #E2E8F0; border-radius: 6px; padding: 6px 10px; width: 80px; font-family: inherit; font-size: 14px; text-align: center; outline: none; transition: border-color 0.2s; }
        .mark-input:focus { border-color: #4DA6FF; background: rgba(77,166,255,0.08); }
        .grade-card { transition: transform 0.2s, box-shadow 0.2s; }
        .grade-card:hover { transform: translateY(-2px); }
        .row-anim { animation: fadeUp 0.3s ease both; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
      `}</style>

      {/* Header */}
      <div style={{ background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "18px 32px", display: "flex", alignItems: "center", gap: "12px" }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: "linear-gradient(135deg, #4DA6FF, #00C896)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🎓</div>
        <div>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 18, letterSpacing: "-0.02em" }}>WAM<span style={{ color: "#4DA6FF" }}>calc</span></div>
          <div style={{ fontSize: 11, color: "#64748B", marginTop: 1 }}>AI-Powered Grade Calculator · Australian Grading System</div>
        </div>
        {step === "calc" && (
          <button onClick={() => { setStep("upload"); setAssessments([]); setMarks({}); setCompleted({}); }}
            style={{ marginLeft: "auto", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#94A3B8", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>
            ↩ New Subject
          </button>
        )}
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "40px 24px" }}>

        {/* UPLOAD STEP */}
        {(step === "upload" || step === "error") && (
          <div style={{ animation: "fadeUp 0.4s ease" }}>
            <div style={{ textAlign: "center", marginBottom: 40 }}>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 36, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.1, marginBottom: 12 }}>
                Upload your <span style={{ background: "linear-gradient(90deg, #4DA6FF, #00C896)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Subject Outline</span>
              </div>
              <div style={{ color: "#64748B", fontSize: 15, maxWidth: 460, margin: "0 auto" }}>
                The AI will extract every assessment, quiz, and exam with their weights — then tell you exactly what you need to score for each grade.
              </div>
            </div>

            <div
              className="upload-zone"
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
              onClick={() => fileRef.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? "#4DA6FF" : "rgba(255,255,255,0.12)"}`,
                borderRadius: 16, padding: "60px 40px", textAlign: "center", cursor: "pointer",
                background: dragOver ? "rgba(77,166,255,0.05)" : "rgba(255,255,255,0.02)",
                transition: "all 0.2s"
              }}>
              <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.html,image/*" style={{ display: "none" }}
                onChange={e => handleFile(e.target.files?.[0])} />
              <div style={{ color: "#4DA6FF", marginBottom: 16 }}><UploadIcon /></div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 16, marginBottom: 8 }}>Drop your file here</div>
              <div style={{ color: "#475569", fontSize: 13 }}>or click to browse · PDF, image, or text file</div>
            </div>

            {step === "error" && (
              <div style={{ marginTop: 20, background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", borderRadius: 10, padding: "14px 18px", color: "#F87171", fontSize: 14 }}>
                ⚠ {error}
              </div>
            )}

            {/* Grade legend */}
            <div style={{ marginTop: 40, display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              {GRADES.map(g => (
                <div key={g.label} style={{ background: g.bg, border: `1px solid ${g.color}30`, borderRadius: 8, padding: "8px 16px", display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: g.color }} />
                  <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, color: g.color, fontSize: 13 }}>{g.label}</span>
                  <span style={{ color: "#64748B", fontSize: 12 }}>{g.name} · {g.min === 0 ? "<50" : g.min + "+"}%</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* LOADING */}
        {step === "loading" && (
          <div style={{ textAlign: "center", padding: "100px 0", animation: "fadeUp 0.3s ease" }}>
            <div style={{ color: "#4DA6FF", marginBottom: 20, display: "flex", justifyContent: "center" }}><SpinnerIcon /></div>
            <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 18, marginBottom: 8 }}>Analysing your subject outline…</div>
            <div style={{ color: "#475569", fontSize: 13 }}>{loadingMsg || "Reading your PDF and extracting all grade components"}</div>
          </div>
        )}

        {/* CALCULATOR */}
        {step === "calc" && (
          <div style={{ animation: "fadeUp 0.4s ease" }}>
            {/* Subject name */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ color: "#64748B", fontSize: 12, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.08em" }}>Subject</div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 26, letterSpacing: "-0.02em" }}>{subjectName}</div>
            </div>

            {/* Current score banner */}
            {projectedFinal !== null && currentGrade && (
              <div style={{ background: `linear-gradient(135deg, ${currentGrade.bg}, rgba(255,255,255,0.02))`, border: `1px solid ${currentGrade.color}40`, borderRadius: 14, padding: "20px 24px", marginBottom: 28, display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 11, color: "#64748B", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.08em" }}>Current Projected Score</div>
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 40, color: currentGrade.color, lineHeight: 1 }}>
                    {projectedFinal.toFixed(1)}<span style={{ fontSize: 20 }}>%</span>
                  </div>
                </div>
                <div style={{ width: 1, height: 50, background: "rgba(255,255,255,0.08)" }} />
                <div>
                  <div style={{ fontSize: 11, color: "#64748B", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.08em" }}>Grade Tracking</div>
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 28, color: currentGrade.color }}>{currentGrade.label} — {currentGrade.name}</div>
                </div>
                <div style={{ marginLeft: "auto", textAlign: "right" }}>
                  <div style={{ fontSize: 11, color: "#64748B", marginBottom: 2 }}>Completed</div>
                  <div style={{ fontSize: 20, fontWeight: 600 }}>{completedWeight.toFixed(0)}<span style={{ fontSize: 13, color: "#64748B" }}>/{totalWeight.toFixed(0)}%</span></div>
                </div>
              </div>
            )}

            {/* Assessments table */}
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, overflow: "hidden", marginBottom: 28 }}>
              <div style={{ padding: "16px 22px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center" }}>
                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 14 }}>Assessments</div>
                <div style={{ marginLeft: "auto", fontSize: 12, color: "#475569" }}>Enter your marks as you complete each item</div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr style={{ background: "rgba(255,255,255,0.02)" }}>
                      {["Done", "Assessment", "Type", "Weight", "Max Mark", "Your Mark", "Hurdle", "Weighted %"].map(h => (
                        <th key={h} style={{ padding: "10px 22px", textAlign: h === "Done" || h === "Assessment" || h === "Type" ? "left" : "center", fontSize: 11, color: h === "Hurdle" ? "#F87171" : "#475569", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 500 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {assessments.map((a, i) => {
                      const rawMark = parseFloat(marks[a.id]);
                      const pct = !isNaN(rawMark) ? (rawMark / a.maxMark * 100) : null;
                      const weightedPct = pct !== null ? (pct * a.weight / 100) : null;
                      const gradeCol = pct !== null ? getGradeLabel(pct).color : null;
                      return (
                        <tr key={a.id} className="row-anim" style={{ animationDelay: `${i * 0.04}s`, borderTop: "1px solid rgba(255,255,255,0.04)", background: completed[a.id] ? "rgba(255,255,255,0.015)" : "transparent" }}>
                          <td style={{ padding: "14px 22px" }}>
                            <input type="checkbox" checked={!!completed[a.id]}
                              onChange={e => setCompleted(c => ({ ...c, [a.id]: e.target.checked }))}
                              style={{ width: 16, height: 16, accentColor: "#4DA6FF", cursor: "pointer" }} />
                          </td>
                          <td style={{ padding: "14px 22px" }}>
                            <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500, fontSize: 14 }}>{a.name}</div>
                            {a.dueDate && a.dueDate !== "null" && <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>📅 {a.dueDate}</div>}
                          </td>
                          <td style={{ padding: "14px 22px" }}>
                            <span style={{ background: `${typeColors[a.type] || "#94A3B8"}18`, color: typeColors[a.type] || "#94A3B8", borderRadius: 5, padding: "3px 9px", fontSize: 11, fontWeight: 500, textTransform: "capitalize" }}>{a.type}</span>
                          </td>
                          <td style={{ padding: "14px 22px", textAlign: "center", fontWeight: 600, color: "#A78BFA" }}>{a.weight}%</td>
                          <td style={{ padding: "14px 22px", textAlign: "center" }}>
                            <input className="mark-input" type="number" min={1}
                              value={a.maxMark}
                              onChange={e => {
                                const val = Math.max(1, Number(e.target.value) || 1);
                                setAssessments(prev => prev.map(x => x.id === a.id ? { ...x, maxMark: val } : x));
                              }} />
                            <div style={{ marginTop: 4, display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                              <span style={{ fontSize: 10, color: "#F87171" }}>hurdle:</span>
                              <input
                                type="number" min={0} max={a.maxMark} placeholder="none"
                                value={a.hurdleMark ?? ""}
                                onChange={e => {
                                  const val = e.target.value === "" ? undefined : Math.max(0, Number(e.target.value));
                                  setAssessments(prev => prev.map(x => x.id === a.id ? { ...x, hurdleMark: val } : x));
                                }}
                                style={{ background: "transparent", border: "none", borderBottom: "1px solid rgba(248,113,113,0.4)", color: "#F87171", width: 44, fontSize: 10, textAlign: "center", outline: "none", fontFamily: "inherit" }}
                              />
                            </div>
                          </td>
                          <td style={{ padding: "14px 22px", textAlign: "center" }}>
                            {(() => {
                              const raw = parseFloat(marks[a.id]);
                              const hasHurdle = a.hurdleMark !== undefined;
                              const hurdleFailed = hasHurdle && completed[a.id] && !isNaN(raw) && raw < a.hurdleMark!;
                              return (
                                <>
                                  <input className="mark-input" type="number" min={0} max={a.maxMark}
                                    placeholder="—"
                                    value={marks[a.id]}
                                    style={{ borderColor: hurdleFailed ? "#F87171" : undefined, color: hurdleFailed ? "#F87171" : undefined }}
                                    onChange={e => {
                                      setMarks(m => ({ ...m, [a.id]: e.target.value }));
                                      if (e.target.value !== "") setCompleted(c => ({ ...c, [a.id]: true }));
                                    }} />
                                </>
                              );
                            })()}
                          </td>
                          <td style={{ padding: "14px 22px", textAlign: "center" }}>
                            {(() => {
                              const raw = parseFloat(marks[a.id]);
                              if (!a.hurdleMark) return <span style={{ color: "#334155" }}>—</span>;
                              if (!completed[a.id] || isNaN(raw)) {
                                return <span style={{ fontSize: 11, color: "#64748B" }}>need ≥{a.hurdleMark}</span>;
                              }
                              return raw >= a.hurdleMark
                                ? <span style={{ background: "rgba(0,200,150,0.15)", color: "#00C896", borderRadius: 5, padding: "3px 9px", fontSize: 11, fontWeight: 600 }}>Pass</span>
                                : <span style={{ background: "rgba(248,113,113,0.15)", color: "#F87171", borderRadius: 5, padding: "3px 9px", fontSize: 11, fontWeight: 600 }}>Fail</span>;
                            })()}
                          </td>
                          <td style={{ padding: "14px 22px", textAlign: "center" }}>
                            {weightedPct !== null
                              ? <span style={{ color: gradeCol ?? undefined, fontWeight: 600 }}>{weightedPct.toFixed(2)}%</span>
                              : <span style={{ color: "#334155" }}>—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.02)" }}>
                      <td colSpan={3} style={{ padding: "12px 22px", fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 13 }}>Total</td>
                      <td style={{ padding: "12px 22px", textAlign: "center", fontWeight: 700, color: totalWeight === 100 ? "#00C896" : "#FBBF24" }}>{totalWeight}%</td>
                      <td colSpan={3} />
                      <td style={{ padding: "12px 22px", textAlign: "center", fontWeight: 700, color: "#4DA6FF" }}>
                        {currentWeighted > 0 ? currentWeighted.toFixed(2) + "%" : "—"}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Technical fail warning */}
            {isTechnicalFail && (
              <div style={{ marginBottom: 20, background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.4)", borderRadius: 12, padding: "16px 20px" }}>
                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 15, color: "#F87171", marginBottom: 6 }}>
                  ⚠ Technical Fail
                </div>
                <div style={{ fontSize: 13, color: "#CBD5E1", lineHeight: 1.5 }}>
                  {failedHurdles.map(a => (
                    <div key={a.id}>
                      <strong>{a.name}</strong> — you scored {marks[a.id]}/{a.maxMark} but need at least <strong>{a.hurdleMark}</strong> to pass this subject.
                    </div>
                  ))}
                  <div style={{ marginTop: 8, color: "#94A3B8", fontSize: 12 }}>
                    Regardless of your overall average, failing to meet this minimum will result in a fail grade for the subject.
                  </div>
                </div>
              </div>
            )}

            {/* Grade targets */}
            <div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 16, marginBottom: 16 }}>
                Marks Needed for Each Grade
                <span style={{ fontSize: 12, fontWeight: 400, color: "#475569", marginLeft: 10 }}>on remaining {remainingWeight.toFixed(0)}% of assessments</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
                {GRADES.filter(g => g.label !== "F").map(g => {
                  const needed = neededForGrade(g.min);
                  const isAchieved = needed <= 0;
                  const isImpossible = needed > 100;
                  const isNoRemaining = remainingWeight <= 0;
                  return (
                    <div key={g.label} className="grade-card" style={{ background: g.bg, border: `1px solid ${g.color}30`, borderRadius: 12, padding: "18px 20px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                        <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 22, color: g.color }}>{g.label}</span>
                        <span style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>{g.min}%+</span>
                      </div>
                      <div style={{ fontSize: 12, color: "#64748B", marginBottom: 8 }}>{g.name}</div>
                      {isTechnicalFail ? (
                        <div style={{ fontSize: 13, color: "#F87171", fontWeight: 600 }}>✗ Technical fail</div>
                      ) : isNoRemaining ? (
                        <div style={{ fontSize: 13, color: projectedFinal !== null && projectedFinal >= g.min ? g.color : "#F87171", fontWeight: 600 }}>
                          {projectedFinal !== null && projectedFinal >= g.min ? "✓ Achieved" : "✗ Not reached"}
                        </div>
                      ) : isAchieved ? (
                        <div style={{ fontSize: 13, color: g.color, fontWeight: 600 }}>✓ Already on track!</div>
                      ) : isImpossible ? (
                        <div style={{ fontSize: 13, color: "#F87171", fontWeight: 600 }}>✗ No longer possible</div>
                      ) : (
                        <div>
                          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 28, color: g.color, lineHeight: 1 }}>
                            {needed.toFixed(1)}<span style={{ fontSize: 14 }}>%</span>
                          </div>
                          <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>avg on remaining work</div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ marginTop: 24, fontSize: 12, color: "#334155", textAlign: "center" }}>
              💡 Tick the checkbox when you've completed an assessment and entered your mark. The grade targets update in real-time.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
