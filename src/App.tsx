import { useState, useEffect } from "react";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { BottomNav } from "./components/BottomNav";

// Screen Components
import { Dashboard } from "./components/Dashboard";
import { PushFile } from "./components/PushFile";
import { Explorer } from "./components/Explorer";
import { Inspect } from "./components/Inspect";
import { ReposList } from "./components/ReposList";
import { CommitsList } from "./components/CommitsList";
import { AgentChat } from "./components/AgentChat";
import { Settings } from "./components/Settings";

// Interfaces
import { Repo, Branch, GitHubUser, Message, PushLogEntry, AppPrefs, AIConfig } from "./types";

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<string>("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);

  // GitHub credentials state
  const [token, setToken] = useState<string>("");
  const [connected, setConnected] = useState<boolean>(false);
  const [user, setUser] = useState<GitHubUser | null>(null);

  // Repositories & Workspace context state
  const [repos, setRepos] = useState<Repo[]>([]);
  const [activeRepo, setActiveRepo] = useState<Repo | null>(null);
  const [activeBranch, setActiveBranch] = useState<string>("main");
  const [branches, setBranches] = useState<Branch[]>([]);

  // Logs & Messages states (Persisted)
  const [recentPushes, setRecentPushes] = useState<PushLogEntry[]>([]);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome-1",
      role: "assistant",
      content: "👋 Hello! I am your server-side Gemini AI Developer Agent.\n\nI am fully connected to your repository context and authorized to list, read, search, and push file commits directly to your GitHub workspace.\n\nHow can I help you build or inspect your repository today?",
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);

  // General Defaults Prefs
  const [prefs, setPrefs] = useState<AppPrefs>({
    defaultCommit: "Update via Mission Control",
    defaultBranch: "main",
  });

  // Safe fetch helper for github proxy
  const githubProxyRequest = async (path: string, method = "GET", body?: any): Promise<any> => {
    const headers: any = {
      Authorization: `token ${token}`,
      "Content-Type": "application/json",
    };

    const url = `/api/github${path}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || data.message || `HTTP ${res.status}`);
    }
    return data;
  };

  // On App Initial Load: Hydrate states from local storage
  useEffect(() => {
    // 1. Load preferences
    const savedPrefs = localStorage.getItem("mr_prefs");
    if (savedPrefs) {
      try {
        setPrefs(JSON.parse(savedPrefs));
      } catch (e) {}
    }

    // 2. Load recent pushes
    const savedPushes = localStorage.getItem("mr_recent_pushes");
    if (savedPushes) {
      try {
        setRecentPushes(JSON.parse(savedPushes));
      } catch (e) {}
    }

    // 3. Load chat log
    const savedMessages = localStorage.getItem("mr_chat_messages");
    if (savedMessages) {
      try {
        setMessages(JSON.parse(savedMessages));
      } catch (e) {}
    }

    // 4. Load & connect token
    const savedToken = localStorage.getItem("mr_pat");
    if (savedToken) {
      setToken(savedToken);
      authenticateToken(savedToken);
    }
  }, []);

  const authenticateToken = async (pat: string) => {
    try {
      const headers = {
        Authorization: `token ${pat}`,
      };
      // Pull user details to authenticate
      const res = await fetch("/api/github/user", { headers });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "GitHub auth validation failed.");
      }

      setUser(data);
      setConnected(true);

      // Load repositories
      const reposRes = await fetch("/api/github/user/repos?sort=updated&per_page=100", { headers });
      const reposData = await reposRes.json();
      if (reposRes.ok && Array.isArray(reposData)) {
        setRepos(reposData);

        // Auto select last active repo if saved
        const lastRepoFullName = localStorage.getItem("mr_last_repo");
        if (lastRepoFullName) {
          const found = reposData.find((r: Repo) => r.full_name === lastRepoFullName);
          if (found) {
            handleRepoSelect(found, pat);
          }
        }
      }
    } catch (err) {
      console.error("Auto authentication failed", err);
      localStorage.removeItem("mr_pat");
      setConnected(false);
    }
  };

  const loadBranches = async (repo: Repo, pat: string) => {
    try {
      const res = await fetch(`/api/github/repos/${repo.full_name}/branches`, {
        headers: {
          Authorization: `token ${pat}`,
        },
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data)) {
        setBranches(data);
        const lastBranch = localStorage.getItem("mr_last_branch") || repo.default_branch || "main";
        const foundBranch = data.find((b: Branch) => b.name === lastBranch);
        setActiveBranch(foundBranch ? foundBranch.name : data[0]?.name || "main");
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleTokenChange = (pat: string) => {
    setToken(pat);
    localStorage.setItem("mr_pat", pat);
    authenticateToken(pat);
  };

  const handleTokenDisconnect = () => {
    setToken("");
    setConnected(false);
    setUser(null);
    setRepos([]);
    setActiveRepo(null);
    setBranches([]);
    localStorage.removeItem("mr_pat");
    localStorage.removeItem("mr_last_repo");
    localStorage.removeItem("mr_last_branch");
  };

  const handleRepoSelect = (repo: Repo, customToken?: string) => {
    setActiveRepo(repo);
    localStorage.setItem("mr_last_repo", repo.full_name);
    loadBranches(repo, customToken || token);
  };

  const handleBranchSelect = (branchName: string) => {
    setActiveBranch(branchName);
    localStorage.setItem("mr_last_branch", branchName);
  };

  const handleSendMessage = (msg: Message) => {
    const updated = [...messages, msg];
    setMessages(updated);
    localStorage.setItem("mr_chat_messages", JSON.stringify(updated));
  };

  const handlePushCompleted = (path: string, commitSha: string) => {
    const log: PushLogEntry = {
      id: Math.random().toString(),
      timestamp: new Date().toLocaleTimeString() + " - " + new Date().toLocaleDateString(),
      type: "success",
      message: `Pushed file "${path}" (Commit: ${commitSha})`,
    };
    const updated = [...recentPushes, log];
    setRecentPushes(updated);
    localStorage.setItem("mr_recent_pushes", JSON.stringify(updated));
  };

  const handleSavePrefs = (newPrefs: AppPrefs) => {
    setPrefs(newPrefs);
    localStorage.setItem("mr_prefs", JSON.stringify(newPrefs));
  };

  const handlePurgeAll = () => {
    localStorage.clear();
    setToken("");
    setConnected(false);
    setUser(null);
    setRepos([]);
    setActiveRepo(null);
    setBranches([]);
    setRecentPushes([]);
    setMessages([
      {
        id: "welcome-1",
        role: "assistant",
        content: "👋 Hello! I am your server-side Gemini AI Developer Agent. Everything has been reset.",
        timestamp: new Date().toLocaleTimeString(),
      },
    ]);
    setPrefs({
      defaultCommit: "Update via Mission Control",
      defaultBranch: "main",
    });
    setCurrentScreen("dashboard");
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#07090e] text-[#f1f5f9] select-none">
      {/* Header banner */}
      <Header
        connected={connected}
        username={user ? user.login : null}
        activeRepo={activeRepo}
        activeBranch={activeBranch}
        onMenuToggle={() => setSidebarOpen(!sidebarOpen)}
      />

      {/* Main body viewport */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Sidebar Drawer */}
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          repos={repos}
          activeRepo={activeRepo}
          activeBranch={activeBranch}
          branches={branches}
          onRepoChange={(fullName) => {
            const found = repos.find((r) => r.full_name === fullName);
            if (found) handleRepoSelect(found);
          }}
          onBranchChange={handleBranchSelect}
          currentScreen={currentScreen}
          onScreenChange={setCurrentScreen}
        />

        {/* Workspace Canvas */}
        <main className="flex-1 overflow-y-auto px-4 py-4 pb-20 max-w-4xl mx-auto w-full">
          {currentScreen === "dashboard" && (
            <Dashboard
              user={user}
              reposCount={repos.length}
              commitCount={recentPushes.length}
              recentPushes={recentPushes}
              activeRepo={activeRepo}
              activeBranch={activeBranch}
              onScreenChange={setCurrentScreen}
            />
          )}

          {currentScreen === "push" && (
            <PushFile
              activeRepo={activeRepo}
              activeBranch={activeBranch}
              repos={repos}
              onRepoChange={(fullName) => {
                const found = repos.find((r) => r.full_name === fullName);
                if (found) handleRepoSelect(found);
              }}
              onBranchChange={handleBranchSelect}
              onPushSuccess={(log) => {
                const updated = [...recentPushes, log];
                setRecentPushes(updated);
                localStorage.setItem("mr_recent_pushes", JSON.stringify(updated));
              }}
              pushLog={recentPushes}
              onClearLog={() => {
                setRecentPushes([]);
                localStorage.setItem("mr_recent_pushes", "[]");
              }}
              githubProxyRequest={githubProxyRequest}
            />
          )}

          {currentScreen === "explorer" && (
            <Explorer
              activeRepo={activeRepo}
              activeBranch={activeBranch}
              githubProxyRequest={githubProxyRequest}
              onFileSelectForEdit={(path, content) => {
                // Pre-fill edits in the state context
                const pathInput = document.getElementById("push-file-path") as HTMLInputElement;
                if (pathInput) pathInput.value = path;
                const contentInput = document.getElementById("push-content") as HTMLTextAreaElement;
                if (contentInput) contentInput.value = content;
              }}
              onScreenChange={setCurrentScreen}
            />
          )}

          {currentScreen === "inspect" && (
            <Inspect
              activeRepo={activeRepo}
              activeBranch={activeBranch}
              githubProxyRequest={githubProxyRequest}
            />
          )}

          {currentScreen === "repos" && (
            <ReposList
              repos={repos}
              activeRepo={activeRepo}
              onRepoSelect={handleRepoSelect}
              onRefresh={async () => {
                const headers = { Authorization: `token ${token}` };
                const res = await fetch("/api/github/user/repos?sort=updated&per_page=100", { headers });
                const data = await res.json();
                if (res.ok && Array.isArray(data)) {
                  setRepos(data);
                }
              }}
              githubProxyRequest={githubProxyRequest}
            />
          )}

          {currentScreen === "commits" && (
            <CommitsList
              activeRepo={activeRepo}
              activeBranch={activeBranch}
              githubProxyRequest={githubProxyRequest}
            />
          )}

          {currentScreen === "agent" && (
            <AgentChat
              activeRepo={activeRepo}
              activeBranch={activeBranch}
              githubToken={token}
              messages={messages}
              onSendMessage={handleSendMessage}
              onClearChat={() => {
                setMessages([
                  {
                    id: "welcome-1",
                    role: "assistant",
                    content: "👋 Hello! I am your server-side Gemini AI Developer Agent. Conversational log cleared.",
                    timestamp: new Date().toLocaleTimeString(),
                  },
                ]);
                localStorage.setItem("mr_chat_messages", "[]");
              }}
            />
          )}

          {currentScreen === "settings" && (
            <Settings
              token={token}
              onTokenChange={handleTokenChange}
              onTokenDisconnect={handleTokenDisconnect}
              user={user}
              prefs={prefs}
              onPrefsSave={handleSavePrefs}
              aiConfig={{ provider: "gemini", apiKey: "", baseUrl: "", model: "gemini-3.5-flash" }}
              onAIConfigSave={() => {}}
              onPurgeAll={handlePurgeAll}
              githubProxyRequest={githubProxyRequest}
            />
          )}
        </main>
      </div>

      {/* Mobile-first bottom utility navigations */}
      <BottomNav currentScreen={currentScreen} onScreenChange={setCurrentScreen} />
    </div>
  );
}
