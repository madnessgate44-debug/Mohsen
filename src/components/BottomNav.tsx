import React from "react";
import { LayoutDashboard, UploadCloud, FolderOpen, Bot, Settings } from "lucide-react";

interface BottomNavProps {
  currentScreen: string;
  onScreenChange: (screen: string) => void;
}

export const BottomNav: React.FC<BottomNavProps> = ({ currentScreen, onScreenChange }) => {
  const navItems = [
    { id: "dashboard", label: "Home", icon: LayoutDashboard },
    { id: "push", label: "Push", icon: UploadCloud },
    { id: "explorer", label: "Files", icon: FolderOpen },
    { id: "agent", label: "AI Agent", icon: Bot },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 h-16 bg-slate-900/90 backdrop-blur-md border-t border-slate-800 flex items-stretch justify-around px-2 pb-safe z-50">
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive = currentScreen === item.id;
        return (
          <button
            key={item.id}
            id={`nav-btn-${item.id}`}
            onClick={() => onScreenChange(item.id)}
            className={`flex-1 flex flex-col items-center justify-center gap-1 transition-all duration-150 active:scale-90 ${
              isActive ? "text-blue-400" : "text-slate-500 hover:text-slate-300"
            }`}
          >
            <Icon className={`w-5 h-5 ${isActive ? "stroke-[2.5px]" : "stroke-[2px]"}`} />
            <span className="text-[10px] font-semibold tracking-wider uppercase">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
};
