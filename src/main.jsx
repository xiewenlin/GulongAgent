import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { ConfirmDialogProvider } from "./components/ConfirmDialog.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ConfirmDialogProvider>
      <App />
    </ConfirmDialogProvider>
  </React.StrictMode>,
);
