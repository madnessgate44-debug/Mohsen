import React from "react";
import {
  X,
  LayoutDashboard,
  Upload,
  FolderOpen,
  Database,
  GitBranch,
  Bot,
  Settings,
  Rocket,
  Code2,
  FolderKanban,
} from "lucide-react";
import { Repo, Branch } from "../types";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  currentScreen: string;
  onScreenChange: (screen: string) => void;
  repos: Repo[];
  activeRepo: Repo | null;
  onRepoChange: (repoName: string) => void;
  branches: Branch[];
  activeBranch: string;
  onBranchChange: (branchName: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  onClose,
  currentScreen,
  onScreenChange,
  repos,
  activeRepo,
  onRepoChange,
  branches,
  activeBranch,
  onBranchChange,
}) => {
  const navLinks = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "push", label: "Push File", icon: Upload },
    { id: "explorer", label: "File Explorer", icon: FolderOpen },
    { id: "inspect", label: "Inspect Repo", icon: Code2 },
    { id: "repos", label: "Repositories", icon: Database },
    { id: "commits", label: "Commit History", icon: GitBranch },
    { id: "agent", label: "AI Agent Chat", icon: Bot },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  return (
    <>
      {/* Overlay */}
      {isOpen && (
        <div
          onClick={onClose}
          className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 transition-opacity duration-200"
        />
      )}

      {/* Sidebar drawer */}
      <aside
        id="sidebar"
        className={`fixed top-0 bottom-0 left-0 w-72 max-w-[80vw] bg-slate-900 border-r border-slate-800 z-50 flex flex-col transition-transform duration-280 cubic-bezier(0.4, 0, 0.2, 1) ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="h-14 flex items-center px-4 border-b border-slate-800 gap-2 shrink-0">
          <Rocket className="w-5 h-5 text-blue-500 animate-pulse" />
          <span className="font-bold text-sm tracking-wider uppercase bg-gradient-to-r from-slate-100 via-blue-100 to-blue-400 bg-clip-text text-transparent">
            MISSION RUNNER
          </span>
          <button
            onClick={onClose}
            className="ml-auto w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white rounded-lg active:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Repos Select Box */}
        <div className="p-3 border-b border-slate-800 shrink-0">
          <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
            <FolderKanban className="w-3.5 h-3.5 text-blue-500" />
            Repository
          </label>
          <select
            id="sidebar-repo-select"
            value={activeRepo ? activeRepo.full_name : ""}
            onChange={(e) => onRepoChange(e.target.value)}
            className="w-full h-9 bg-slate-950 border border-slate-850 hover:border-slate-700 rounded-lg text-xs px-2.5 text-slate-200 focus:border-blue-500 outline-none cursor-pointer"
          >
            <option value="">-- Select Repo --</option>
            {repos.map((r) => (
              <option key={r.id} value={r.full_name}>
                {r.full_name}
              </option>
            ))}
          </select>
        </div>

        {/* Branch Select Box */}
        {activeRepo && (
          <div className="p-3 border-b border-slate-800 shrink-0">
            <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
              <GitBranch className="w-3.5 h-3.5 text-emerald-500" />
              Branch
            </label>
            <select
              id="sidebar-branch-select"
              value={activeBranch}
              onChange={(e) => onBranchChange(e.target.value)}
              className="w-full h-9 bg-slate-950 border border-slate-850 hover:border-slate-700 rounded-lg text-xs px-2.5 text-emerald-400 font-mono focus:border-emerald-500 outline-none cursor-pointer"
            >
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Navigation links */}
        <nav className="flex-1 overflow-y-auto py-2 px-2.5 space-y-1">
          {navLinks.map((link) => {
            const LinkIcon = link.icon;
            const isActive = currentScreen === link.id;
            return (
              <button
                key={link.id}
                onClick={() => {
                  onScreenChange(link.id);
                  onClose();
                }}
                className={`w-full h-11 flex items-center px-3 rounded-lg gap-3 text-xs font-semibold transition-all duration-150 active:scale-95 ${
                  isActive
                    ? "bg-blue-600 text-white shadow-md shadow-blue-900/30 font-bold"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-850"
                }`}
              >
                <LinkIcon className="w-4 h-4 shrink-0" />
                <span>{link.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 shrink-0 text-center text-[10px] text-slate-500 font-mono">
          MR v4 · Local Storage Active
        </div>
      </aside>
    </>
  );
};
