import React from "react";
import {
  Activity,
  Bolt,
  History,
  User,
  FolderGit2,
  Upload,
  FolderOpen,
  Bot,
  Compass,
  Star,
  GitBranch,
  Github,
  Award,
} from "lucide-react";
import { Repo, GitHubUser, PushLogEntry } from "../types";

interface DashboardProps {
  user: GitHubUser | null;
  reposCount: number;
  commitCount: number;
  recentPushes: PushLogEntry[];
  activeRepo: Repo | null;
  activeBranch: string;
  onScreenChange: (screen: string) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({
  user,
  reposCount,
  commitCount,
  recentPushes,
  activeRepo,
  activeBranch,
  onScreenChange,
}) => {
  return (
    <div id="screen-dashboard" className="space-y-4 animate-fadein">
      {/* Title */}
      <div className="mb-1">
        <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Dashboard</h2>
        <p className="text-xs text-slate-400">GitHub control hub & real-time telemetry</p>
      </div>

      {/* Telemetry Row */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex items-center gap-3">
          <Activity className="w-5 h-5 text-blue-500 shrink-0" />
          <div className="min-w-0">
            <div className="text-lg font-bold text-white font-mono leading-none">{reposCount}</div>
            <div className="text-[9px] uppercase font-bold text-slate-400 tracking-wider">Repos</div>
          </div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex items-center gap-3">
          <Upload className="w-5 h-5 text-emerald-500 shrink-0" />
          <div className="min-w-0">
            <div className="text-lg font-bold text-white font-mono leading-none">{commitCount}</div>
            <div className="text-[9px] uppercase font-bold text-slate-400 tracking-wider">Pushes</div>
          </div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex items-center gap-3">
          <User className="w-5 h-5 text-amber-500 shrink-0" />
          <div className="min-w-0 truncate">
            <div className="text-sm font-bold text-white truncate leading-none">
              {user ? user.login : "--"}
            </div>
            <div className="text-[9px] uppercase font-bold text-slate-400 tracking-wider">User</div>
          </div>
        </div>
      </div>

      {/* Quick Ops */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center gap-2 text-xs font-bold text-white uppercase tracking-wider border-b border-slate-800 pb-2 mb-3">
          <Bolt className="w-4 h-4 text-amber-500 animate-pulse" />
          Quick Launch
        </div>
        <div className="grid grid-cols-4 gap-2">
          <button
            id="qop-push"
            onClick={() => onScreenChange("push")}
            className="flex flex-col items-center justify-center p-3.5 bg-slate-950 border border-slate-850 hover:border-blue-500 rounded-xl text-center gap-1.5 cursor-pointer active:scale-95 transition-all"
          >
            <Upload className="w-5 h-5 text-emerald-400" />
            <span className="text-[9px] font-bold text-slate-300">Push</span>
          </button>
          <button
            id="qop-explore"
            onClick={() => onScreenChange("explorer")}
            className="flex flex-col items-center justify-center p-3.5 bg-slate-950 border border-slate-850 hover:border-blue-500 rounded-xl text-center gap-1.5 cursor-pointer active:scale-95 transition-all"
          >
            <FolderOpen className="w-5 h-5 text-blue-400" />
            <span className="text-[9px] font-bold text-slate-300">Browse</span>
          </button>
          <button
            id="qop-agent"
            onClick={() => onScreenChange("agent")}
            className="flex flex-col items-center justify-center p-3.5 bg-slate-950 border border-slate-850 hover:border-blue-500 rounded-xl text-center gap-1.5 cursor-pointer active:scale-95 transition-all"
          >
            <Bot className="w-5 h-5 text-purple-400" />
            <span className="text-[9px] font-bold text-slate-300">Agent</span>
          </button>
          <button
            id="qop-history"
            onClick={() => onScreenChange("commits")}
            className="flex flex-col items-center justify-center p-3.5 bg-slate-950 border border-slate-850 hover:border-blue-500 rounded-xl text-center gap-1.5 cursor-pointer active:scale-95 transition-all"
          >
            <History className="w-5 h-5 text-amber-400" />
            <span className="text-[9px] font-bold text-slate-300">History</span>
          </button>
        </div>
      </div>

      {/* Account Profile Card */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center gap-2 text-xs font-bold text-white uppercase tracking-wider border-b border-slate-800 pb-2 mb-3">
          <Github className="w-4 h-4 text-blue-500" />
          Account Profile
        </div>
        {user ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <img
                src={user.avatar_url}
                alt="GitHub Avatar"
                className="w-10 h-10 rounded-full border border-slate-700 bg-slate-800"
              />
              <div>
                <h3 className="font-bold text-white text-sm">{user.name || user.login}</h3>
                <p className="text-[10px] font-mono text-slate-400">@{user.login}</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-xs font-mono">
              <div className="bg-slate-950 border border-slate-850 p-2 rounded-lg">
                <span className="block font-bold text-white">{user.public_repos}</span>
                <span className="text-[9px] text-slate-400 uppercase font-sans font-bold">Public Repos</span>
              </div>
              <div className="bg-slate-950 border border-slate-850 p-2 rounded-lg">
                <span className="block font-bold text-white">{user.followers}</span>
                <span className="text-[9px] text-slate-400 uppercase font-sans font-bold">Followers</span>
              </div>
              <div className="bg-slate-950 border border-slate-850 p-2 rounded-lg">
                <span className="block font-bold text-white">{user.following}</span>
                <span className="text-[9px] text-slate-400 uppercase font-sans font-bold">Following</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-center py-6 text-slate-400 space-y-2">
            <User className="w-10 h-10 text-slate-700 mx-auto" />
            <p className="text-xs">Account not connected. Use Settings to connect with a GitHub PAT.</p>
          </div>
        )}
      </div>

      {/* Active Repo Info */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center gap-2 text-xs font-bold text-white uppercase tracking-wider border-b border-slate-800 pb-2 mb-3">
          <FolderGit2 className="w-4 h-4 text-emerald-500" />
          Active Workspace
        </div>
        {activeRepo ? (
          <div className="space-y-3">
            <div>
              <h3 className="font-bold text-white text-sm">{activeRepo.name}</h3>
              <p className="text-xs text-slate-400 mt-1 line-clamp-2">
                {activeRepo.description || "No description provided."}
              </p>
            </div>
            <div className="divider border-slate-800 border-t my-2" />
            <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-xs font-mono">
              <div className="flex items-center gap-1.5">
                <GitBranch className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                <span className="text-slate-400">Branch:</span>
                <span className="font-semibold text-white">{activeBranch}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Star className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span className="text-slate-400">Stars:</span>
                <span className="font-semibold text-white">{activeRepo.stargazers_count}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Compass className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                <span className="text-slate-400">Default:</span>
                <span className="font-semibold text-white">{activeRepo.default_branch}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Award className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                <span className="text-slate-400">Lang:</span>
                <span className="font-semibold text-white truncate max-w-[80px]">
                  {activeRepo.language || "None"}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-center py-6 text-slate-400 space-y-2">
            <Compass className="w-10 h-10 text-slate-700 mx-auto" />
            <p className="text-xs">No active repository. Open Repositories list or select one in the sidebar.</p>
          </div>
        )}
      </div>

      {/* Recent Pushes */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center gap-2 text-xs font-bold text-white uppercase tracking-wider border-b border-slate-800 pb-2 mb-2">
          <History className="w-4 h-4 text-purple-500" />
          Recent Actions Log
        </div>
        {recentPushes.length === 0 ? (
          <div className="text-center py-6 text-slate-500">
            <p className="text-xs">No pushes or actions recorded in this session.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-800/60 max-h-48 overflow-y-auto pr-1">
            {recentPushes
              .slice()
              .reverse()
              .map((push) => (
                <div key={push.id} className="py-2.5 flex items-start justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-200 line-clamp-1">{push.message}</p>
                    <p className="text-[10px] text-slate-500 font-mono mt-0.5">{push.timestamp}</p>
                  </div>
                  <span
                    className={`shrink-0 text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
                      push.type === "success"
                        ? "bg-emerald-950 text-emerald-400 border border-emerald-900/45"
                        : "bg-blue-950 text-blue-400 border border-blue-900/45"
                    }`}
                  >
                    {push.type}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
};
