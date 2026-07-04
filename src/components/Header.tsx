import React, { useEffect, useState } from "react";
import { Menu, Wifi, WifiOff, FolderKanban, ShieldCheck } from "lucide-react";
import { Repo } from "../types";

interface HeaderProps {
  onMenuToggle: () => void;
  connected: boolean;
  username: string | null;
  activeRepo: Repo | null;
  activeBranch: string;
}

export const Header: React.FC<HeaderProps> = ({
  onMenuToggle,
  connected,
  username,
  activeRepo,
  activeBranch,
}) => {
  const [timeStr, setTimeStr] = useState<string>("");

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTimeStr(now.toISOString().replace("T", " ").substring(0, 16) + " UTC");
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="h-14 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-3 shrink-0 z-40 gap-2">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <button
          id="btn-menu-toggle"
          onClick={onMenuToggle}
          className="w-10 h-10 flex items-center justify-center text-slate-300 hover:text-white rounded-lg active:bg-slate-800 transition-all"
        >
          <Menu className="w-6 h-6" />
        </button>

        {/* Connection status */}
        <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono">
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              connected ? "bg-emerald-500 shadow-[0_0_8px_#10b981]" : "bg-rose-500"
            }`}
          />
          <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">
            {connected ? "ON" : "OFF"}
          </span>
        </div>

        {/* User login */}
        {connected && username && (
          <div className="flex items-center gap-1 px-2 py-1 bg-blue-950/40 border border-blue-900/40 rounded-lg text-[10px] font-semibold text-blue-400 font-mono">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>@{username}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {activeRepo && (
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-slate-950 border border-slate-850 rounded-lg text-[11px] text-slate-300 font-mono">
            <FolderKanban className="w-3.5 h-3.5 text-blue-400" />
            <span className="font-semibold">{activeRepo.name}</span>
            <span className="text-slate-500">@{activeBranch}</span>
          </div>
        )}

        <div className="bg-blue-950/40 border border-blue-900/40 text-blue-400 px-2.5 py-1 rounded-lg text-[10px] font-bold font-mono tracking-wider">
          {timeStr || "LOADING UTC"}
        </div>
      </div>
    </header>
  );
};
