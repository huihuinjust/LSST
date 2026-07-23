import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HistoryTrainer } from "../app/HistoryTrainer";
import "../app/globals.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("页面挂载点不存在");
}

createRoot(root).render(
  <StrictMode>
    <HistoryTrainer />
  </StrictMode>,
);
