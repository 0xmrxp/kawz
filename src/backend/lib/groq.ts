import Groq from "groq-sdk";

let _groq: Groq | null = null;

// Lazy singleton — one connection reused across all route modules in the same process.
export function groqClient(apiKey: string): Groq {
  if (!_groq) _groq = new Groq({ apiKey });
  return _groq;
}
