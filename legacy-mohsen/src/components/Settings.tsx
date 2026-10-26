import React, { useState } from "react";
import {
  KeyRound,
  ShieldCheck,
  Compass,
  Sliders,
  AlertTriangle,
  Github,
  CheckCircle,
  HelpCircle,
  Database,
  Sparkles,
} from "lucide-react";
import { GitHubUser, AppPrefs, AIConfig } from "../types";

interface SettingsProps {
  token: string;
  onTokenChange: (token: string) => void;
  onTokenDisconnect: () => void;
  user: GitHubUser | null;
  prefs: AppPrefs;
  onPrefsSave: (prefs: AppPrefs) => void;
  aiConfig: AIConfig;
  onAIConfigSave: (config: AIConfig) => void;
  onPurgeAll: () => void;
  githubProxyRequest: (path: string, method: string, body?: any) => Promise<any>;
}

export const Settings: React.FC<SettingsProps> = ({
  token,
  onTokenChange,
  onTokenDisconnect,
  user,
  prefs,
  onPrefsSave,
  aiConfig,
  onAIConfigSave,
  onPurgeAll,
  githubProxyRequest,
}) => {
  const [patInput, setPatInput] = useState<string>(token);
  const [loadingUser, setLoadingUser] = useState<boolean>(false);

  // Prefs states
  const [defaultCommit, setDefaultCommit] = useState<string>(prefs.defaultCommit);
  const [defaultBranch, setDefaultBranch] = useState<string>(prefs.defaultBranch);

  const handleConnectToken = async () => {
    if (!patInput.trim()) {
      alert("Please enter a valid GitHub token.");
      return;
    }
    setLoadingUser(true);
    try {
      // Test the token against /user proxy endpoint
      const headers = {
        Authorization: `token ${patInput.trim()}`,
      };
      // Make direct request using proxy
      const res = await fetch("/api/github/user", {
        headers,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "GitHub test auth failed.");
      }

      onTokenChange(patInput.trim());
      alert(`✓ Authenticated successfully as @${data.login}!`);
    } catch (err: any) {
      alert("✗ Authentication failed: " + err.message);
    } finally {
      setLoadingUser(false);
    }
  };

  const handleSavePrefs = () => {
    onPrefsSave({
      defaultCommit: defaultCommit.trim() || "Update via Mission Control",
      defaultBranch: defaultBranch.trim() || "main",
    });
    alert("✓ Preferences saved successfully!");
  };

  return (
    <div id="screen-settings" className="space-y-4 animate-fadein">
      {/* Title */}
      <div className="mb-1 shrink-0">
        <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Settings</h2>
        <p className="text-xs text-slate-400">Configure OAuth scopes, template guidelines, and engine details</p>
      </div>

      <div className="space-y-4 max-h-[520px] overflow-y-auto pr-1">
        {/* GitHub PAT Connection */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
          <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-800 pb-2">
            <KeyRound className="w-4 h-4 text-blue-500" />
            GitHub Authenticator
          </h3>
          <p className="text-[10px] text-slate-400">
            Securely save your Personal Access Token (PAT) to perform commits. Requires "repo" permissions.
          </p>

          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono">
              GitHub Token (PAT)
            </span>
            <input
              type="password"
              value={patInput}
              onChange={(e) => setPatInput(e.target.value)}
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxx"
              className="w-full h-11 px-3.5 rounded-lg bg-slate-950 border border-slate-850 focus:border-blue-500 font-mono text-xs text-slate-100 outline-none"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleConnectToken}
              disabled={loadingUser}
              className="flex-1 h-10 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-lg text-xs flex items-center justify-center gap-1.5 active:scale-95 disabled:opacity-50 transition cursor-pointer"
            >
              {loadingUser && (
                <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
              )}
              {loadingUser ? "Authenticating..." : "Connect Account"}
            </button>
            {token && (
              <button
                onClick={() => {
                  onTokenDisconnect();
                  setPatInput("");
                }}
                className="h-10 px-4 border border-rose-900/40 text-rose-400 hover:bg-rose-950/20 text-xs font-semibold rounded-lg flex items-center justify-center gap-1 transition"
              >
                Disconnect
              </button>
            )}
          </div>

          {user && (
            <div className="bg-slate-950/40 border border-slate-850 p-2.5 rounded-lg flex items-center gap-2.5">
              <img src={user.avatar_url} alt="Profile" className="w-6 h-6 rounded-full border border-slate-800" />
              <div className="text-[11px] font-mono text-slate-300">
                Connected as <strong className="text-white">@{user.login}</strong> ({user.public_repos} repos)
              </div>
            </div>
          )}
        </div>

        {/* AI Agent pre-configured panel */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
          <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-800 pb-2">
            <Sparkles className="w-4 h-4 text-emerald-500" />
            AI Developer Engine
          </h3>
          <div className="bg-emerald-950/30 border border-emerald-900/35 p-3.5 rounded-xl space-y-2">
            <span className="text-[10px] font-bold text-emerald-400 font-mono uppercase tracking-wider flex items-center gap-1">
              <CheckCircle className="w-4 h-4" /> Server-side Gemini Configured
            </span>
            <p className="text-xs text-slate-300 leading-relaxed">
              Your AI Agent is fully pre-configured server-side using Google Gemini (model:{" "}
              <strong className="font-mono text-emerald-400 bg-emerald-950/80 px-1 rounded border border-emerald-900/30">
                gemini-3.5-flash
              </strong>
              ).
            </p>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Google AI Studio automatically manages and injects the secure secret credentials at runtime.
              You do not need to provide or update any API Keys.
            </p>
          </div>
        </div>

        {/* Template Defaults Preferences */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
          <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-800 pb-2">
            <Sliders className="w-4 h-4 text-amber-500" />
            General Templates
          </h3>
          <p className="text-[10px] text-slate-400">
            Define default commit template texts and default workspace branch pointers.
          </p>

          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono">
              Default Commit Message
            </span>
            <input
              type="text"
              value={defaultCommit}
              onChange={(e) => setDefaultCommit(e.target.value)}
              placeholder="Update via Mission Control"
              className="w-full h-10 px-3.5 rounded-lg bg-slate-950 border border-slate-850 focus:border-blue-500 font-mono text-xs text-slate-100 outline-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono">
              Default Branch Selector
            </span>
            <input
              type="text"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              placeholder="main"
              className="w-full h-10 px-3.5 rounded-lg bg-slate-950 border border-slate-850 focus:border-blue-500 font-mono text-xs text-slate-100 outline-none"
            />
          </div>

          <button
            onClick={handleSavePrefs}
            className="w-full h-10 border border-slate-700 hover:bg-slate-850 text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 active:scale-95 transition cursor-pointer"
          >
            Save General Templates
          </button>
        </div>

        {/* Danger Zone */}
        <div className="bg-slate-900 border border-rose-950 rounded-xl p-4 space-y-3">
          <h3 className="text-xs font-bold text-rose-400 uppercase tracking-wider flex items-center gap-1.5 border-b border-rose-950 pb-2">
            <AlertTriangle className="w-4 h-4 text-rose-500" />
            Danger Zone
          </h3>
          <p className="text-[10px] text-slate-400">
            Purges all credentials, chat history, recent log files, and preferences from local storage.
          </p>

          <button
            onClick={() => {
              if (window.confirm("CRITICAL ACTION: Are you sure you want to completely wipe all locally cached data? This cannot be undone.")) {
                onPurgeAll();
              }
            }}
            className="w-full h-10 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-lg text-xs flex items-center justify-center gap-1.5 active:scale-95 transition cursor-pointer"
          >
            Wipe Cache & Disconnect All
          </button>
        </div>
      </div>
    </div>
  );
};
