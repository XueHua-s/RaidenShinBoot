import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Refine } from "@refinedev/core";
import routerProvider from "@refinedev/react-router-v6";
import { App } from "./App.js";
import { dataProvider } from "./lib/dataProvider.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
      <Refine
        routerProvider={routerProvider}
        dataProvider={dataProvider}
        resources={[
          { name: "users", list: "/" },
          { name: "messages", list: "/" },
          { name: "memories", list: "/" }
        ]}
        options={{
          syncWithLocation: false,
          warnWhenUnsavedChanges: false
        }}
      >
        <App />
      </Refine>
    </BrowserRouter>
  </StrictMode>
);
