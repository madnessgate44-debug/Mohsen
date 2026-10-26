/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  Shield,
  GitBranch,
  Terminal,
  FileCheck2,
  AlertTriangle,
  Play,
  RotateCw,
  GitPullRequest,
  CheckCircle2,
  XCircle,
  HelpCircle,
  ExternalLink,
  Smartphone,
  Cpu,
  Layers,
  FileText
} from 'lucide-react';
import { TaskExecutionReport, TaskStatus } from './types/agent.ts';

export default function App() {
  const [activeTab, setActiveTab] = useState<'agent' | 'matrix' | 'coordination' | 'export'>('agent');
  const [repoStatus, setRepoStatus] = useState<any>(null);
  const [healthStatus, setHealthStatus] = useState<any>(null);
  const [loadingRepo, setLoadingRepo] = useState(false);
  const [executingTask, setExecutingTask] = useState(false);
  const [currentReport, setCurrentReport] = useState<TaskExecutionReport | null>(null);
  const [coordinationContent, setCoordinationContent] = useState<string>('');

  // Task form state
  const [taskTitle, setTaskTitle] = useState('Verify Repository Baseline & Core Types');
  const [taskDescription, setTaskDescription] = useState('Run TypeScript verification checks and ensure no syntax or typing errors exist in codebase.');
  const [targetRepo, setTargetRepo] = useState('madnessgate44-debug/Firstborn');
  const [githubToken, setGithubToken] = useState('');
  const [allowPr, setAllowPr] = useState(false);

  // Negative test state
  const [negativeTestMsg, setNegativeTestMsg] = useState<string | null>(null);

  useEffect(() => {
    fetchHealth();
    fetchRepoInspection();
    fetchCoordinationDoc();
  }, []);

  const fetchHealth = async () => {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        setHealthStatus(data);
      }
    } catch {
      // Offline fallback
    }
  };

  const fetchRepoInspection = async () => {
    setLoadingRepo(true);
    try {
      const headers: Record<string, string> = {};
      if (githubToken.trim()) {
        headers['Authorization'] = `Bearer ${githubToken.trim()}`;
      }
      const res = await fetch(`/api/github/inspect?repo=${encodeURIComponent(targetRepo)}`, { headers });
      const data = await res.json();
      setRepoStatus(res.ok ? data : { exists: false, errorMessage: data.error });
    } catch (err: any) {
      setRepoStatus({ exists: false, errorMessage: err.message });
    } finally {
      setLoadingRepo(false);
    }
  };

  const fetchCoordinationDoc = async () => {
    try {
      const res = await fetch('/api/coordination');
      if (res.ok) {
        const data = await res.json();
        setCoordinationContent(data.content);
      }
    } catch {
      // Handled silently
    }
  };

  const runTask = async () => {
    setExecutingTask(true);
    setNegativeTestMsg(null);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (githubToken.trim()) {
        headers['Authorization'] = `Bearer ${githubToken.trim()}`;
      }

      const res = await fetch('/api/tasks/run', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: taskTitle,
          description: taskDescription,
          targetRepo,
          allowPrCreation: allowPr,
        }),
      });

      const report = await res.json();
      if (!res.ok || !report.status) {
        alert(`Request rejected (HTTP ${res.status}): ${report.error || 'unknown error'}`);
        return;
      }
      setCurrentReport(report as TaskExecutionReport);
    } catch (err: any) {
      alert(`Task execution failed: ${err.message}`);
    } finally {
      setExecutingTask(false);
    }
  };

  const triggerNegativeTest = async () => {
    setNegativeTestMsg(null);
    try {
      const res = await fetch('/api/tasks/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(githubToken.trim() ? { Authorization: `Bearer ${githubToken.trim()}` } : {}),
        },
        body: JSON.stringify({
          title: '',
          description: '',
          targetRepo: 'madnessgate44-debug/Firstborn',
        }),
      });
      const report: TaskExecutionReport & { error?: string } = await res.json();
      if (!res.ok && !report.status) {
        setNegativeTestMsg(`NEGATIVE TEST BLOCKED: HTTP ${res.status} ${report.error ?? ''}. Enter a valid GitHub PAT.`);
        return;
      }
      if (report.status === 'FAILED') {
        setNegativeTestMsg(`NEGATIVE TEST PASSED: Task was rejected as expected with error: "${report.errorMessage}"`);
      } else {
        setNegativeTestMsg(`NEGATIVE TEST FAILED: Task was unexpectedly accepted with status ${report.status}`);
      }
    } catch (err: any) {
      setNegativeTestMsg(`NEGATIVE TEST EXCEPTION: ${err.message}`);
    }
  };

  const getStatusBadge = (status: TaskStatus) => {
    const styles: Record<TaskStatus, string> = {
      QUEUED: 'bg-slate-800 text-slate-300 border-slate-700',
      VALIDATING: 'bg-indigo-950 text-indigo-300 border-indigo-800',
      INSPECTING: 'bg-sky-950 text-sky-300 border-sky-800',
      PLANNING: 'bg-purple-950 text-purple-300 border-purple-800',
      EDITING: 'bg-amber-950 text-amber-300 border-amber-800',
      TESTING: 'bg-yellow-950 text-yellow-300 border-yellow-800',
      VERIFYING: 'bg-emerald-950 text-emerald-300 border-emerald-800',
      PR_OPENED: 'bg-green-950 text-green-300 border-green-700',
      FAILED: 'bg-rose-950 text-rose-300 border-rose-800',
      BLOCKED: 'bg-red-950 text-red-300 border-red-800',
      CANCELLED: 'bg-slate-800 text-slate-400 border-slate-700',
    };
    return (
      <span className={`px-2.5 py-1 text-xs font-mono font-semibold rounded-md border ${styles[status] || styles.QUEUED}`}>
        {status}
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans pb-16">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center font-black text-white text-base shadow-sm">
              F
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-bold text-sm tracking-tight text-white">FIRSTBORN</span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-mono">
                  FORGE v1.0
                </span>
              </div>
              <p className="text-[11px] text-slate-400">Mobile Operator Control</p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <div className="flex items-center space-x-1.5 text-xs bg-slate-800/80 px-2.5 py-1 rounded-md border border-slate-700/60">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              <span className="text-slate-300 font-mono text-[11px]">{healthStatus?.model?.model || healthStatus?.activeModel || 'keyless / freelm'}</span>
            </div>
          </div>
        </div>
      </header>

      <nav className="bg-slate-900/40 border-b border-slate-800/80 px-3 py-2 sticky top-[57px] z-40 backdrop-blur">
        <div className="max-w-4xl mx-auto flex space-x-1 overflow-x-auto text-xs font-medium scrollbar-none">
          <button
            onClick={() => setActiveTab('agent')}
            className={`px-3 py-1.5 rounded-md flex items-center space-x-1.5 transition-colors whitespace-nowrap ${
              activeTab === 'agent'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Agent Console</span>
          </button>
          <button
            onClick={() => setActiveTab('matrix')}
            className={`px-3 py-1.5 rounded-md flex items-center space-x-1.5 transition-colors whitespace-nowrap ${
              activeTab === 'matrix'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <FileCheck2 className="w-3.5 h-3.5" />
            <span>AC Matrix (1-18)</span>
          </button>
          <button
            onClick={() => setActiveTab('coordination')}
            className={`px-3 py-1.5 rounded-md flex items-center space-x-1.5 transition-colors whitespace-nowrap ${
              activeTab === 'coordination'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>COORDINATION.md</span>
          </button>
          <button
            onClick={() => setActiveTab('export')}
            className={`px-3 py-1.5 rounded-md flex items-center space-x-1.5 transition-colors whitespace-nowrap ${
              activeTab === 'export'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>Phone Export</span>
          </button>
        </div>
      </nav>

      <main className="max-w-4xl mx-auto w-full p-4 flex-1 space-y-4">
        {activeTab === 'agent' && (
          <div className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <GitBranch className="w-4 h-4 text-indigo-400" />
                  <h2 className="text-sm font-semibold text-white">Target Repository Inspection</h2>
                </div>
                <button
                  onClick={fetchRepoInspection}
                  disabled={loadingRepo}
                  className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs flex items-center space-x-1 border border-slate-700"
                >
                  <RotateCw className={`w-3 h-3 ${loadingRepo ? 'animate-spin' : ''}`} />
                  <span className="text-[11px]">Refresh</span>
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/80">
                  <span className="text-slate-400 block text-[11px]">Repository Slug</span>
                  <span className="font-mono text-slate-200 font-medium">{targetRepo}</span>
                </div>
                <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/80">
                  <span className="text-slate-400 block text-[11px]">GitHub Status</span>
                  {repoStatus?.exists ? (
                    <span className="text-emerald-400 font-semibold flex items-center space-x-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>EXISTS (Base SHA: {repoStatus.latestCommitSha?.slice?.(0, 7) || '—'})</span>
                    </span>
                  ) : (
                    <span className="text-amber-400 font-semibold flex items-center space-x-1">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span>NOT FOUND / UNAVAILABLE</span>
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
              <h2 className="text-sm font-semibold text-white flex items-center space-x-2">
                <Terminal className="w-4 h-4 text-indigo-400" />
                <span>Submit Task to Forge</span>
              </h2>

              <div className="space-y-2.5 text-xs">
                <div>
                  <label className="block text-slate-400 text-[11px] mb-1">Task Title</label>
                  <input
                    type="text"
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 text-[11px] mb-1">Task Description & Acceptance Criteria</label>
                  <textarea
                    rows={3}
                    value={taskDescription}
                    onChange={(e) => setTaskDescription(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-slate-400 text-[11px] mb-1">Target Repository</label>
                    <input
                      type="text"
                      value={targetRepo}
                      onChange={(e) => setTargetRepo(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 text-[11px] mb-1">GitHub PAT (Required)</label>
                    <input
                      type="password"
                      placeholder="ghp_... (stored only in memory)"
                      value={githubToken}
                      onChange={(e) => setGithubToken(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                    />
                  </div>
                </div>

                <div className="flex items-center space-x-2 pt-1">
                  <input
                    type="checkbox"
                    id="allowPr"
                    checked={allowPr}
                    onChange={(e) => setAllowPr(e.target.checked)}
                    className="rounded bg-slate-950 border-slate-700 text-indigo-600 focus:ring-0"
                  />
                  <label htmlFor="allowPr" className="text-slate-300 text-xs cursor-pointer">
                    Authorize Pull Request creation if repository checks pass
                  </label>
                </div>
              </div>

              <div className="pt-2 flex flex-wrap gap-2">
                <button
                  onClick={runTask}
                  disabled={executingTask}
                  className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs py-2.5 px-4 rounded-lg flex items-center justify-center space-x-2 transition-colors disabled:opacity-50 shadow-sm"
                >
                  <Play className={`w-3.5 h-3.5 ${executingTask ? 'animate-spin' : ''}`} />
                  <span>{executingTask ? 'Forge Executing Task...' : 'Execute Task with Forge'}</span>
                </button>

                <button
                  onClick={triggerNegativeTest}
                  disabled={executingTask}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs py-2.5 px-3 rounded-lg border border-slate-700 transition-colors flex items-center space-x-1"
                >
                  <span>Test Negative Path (Validation Rejection)</span>
                </button>
              </div>

              {negativeTestMsg && (
                <div className="mt-2 p-2.5 rounded-lg bg-indigo-950/40 border border-indigo-800/60 text-xs font-mono text-indigo-200">
                  {negativeTestMsg}
                </div>
              )}
            </div>

            {currentReport && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
                  <div className="flex items-center space-x-2">
                    <FileCheck2 className="w-4 h-4 text-emerald-400" />
                    <h3 className="text-sm font-semibold text-white">Execution Report: {currentReport.taskId}</h3>
                  </div>
                  <div>{getStatusBadge(currentReport.status)}</div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  <div className="bg-slate-950 p-2 rounded border border-slate-800">
                    <span className="text-slate-400 text-[10px] block">Model Provider</span>
                    <span className="font-mono text-slate-200">{currentReport.modelInvoked?.provider ?? '—'}</span>
                  </div>
                  <div className="bg-slate-950 p-2 rounded border border-slate-800">
                    <span className="text-slate-400 text-[10px] block">Inference Model</span>
                    <span className="font-mono text-slate-200">{currentReport.modelInvoked?.model ?? '—'}</span>
                  </div>
                  <div className="bg-slate-950 p-2 rounded border border-slate-800">
                    <span className="text-slate-400 text-[10px] block">Base Commit</span>
                    <span className="font-mono text-slate-200">{currentReport.baseCommitSha?.slice?.(0, 7) ?? '—'}</span>
                  </div>
                  <div className="bg-slate-950 p-2 rounded border border-slate-800">
                    <span className="text-slate-400 text-[10px] block">Status</span>
                    <span className="font-mono text-slate-200">{currentReport.status}</span>
                  </div>
                </div>

                {currentReport.errorMessage && (
                  <div className="bg-rose-950/40 border border-rose-800/50 rounded-lg p-2.5 text-xs text-rose-200 font-mono">
                    {currentReport.errorMessage}
                  </div>
                )}
                {currentReport.blockerReason && (
                  <div className="bg-amber-950/40 border border-amber-800/50 rounded-lg p-2.5 text-xs text-amber-200 font-mono">
                    BLOCKED: {currentReport.blockerReason}
                  </div>
                )}
                {currentReport.prUrl && (
                  <a href={currentReport.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center space-x-1 text-xs text-indigo-300 hover:text-indigo-200">
                    <GitPullRequest className="w-3.5 h-3.5" />
                    <span>Open PR #{currentReport.prNumber}</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'matrix' && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-xs text-slate-300 space-y-2">
            <h2 className="text-sm font-semibold text-white flex items-center space-x-2">
              <FileCheck2 className="w-4 h-4 text-indigo-400" />
              <span>Acceptance Criteria Matrix</span>
            </h2>
            <p className="text-slate-400">Submit a task to populate the live requirements-to-evidence matrix.</p>
            {currentReport?.requirements?.length ? (
              <ul className="space-y-2">
                {currentReport.requirements.map((r: any) => (
                  <li key={r.id} className="bg-slate-950 border border-slate-800 rounded-lg p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-slate-200">{r.id}</span>
                      <span className="text-[10px] uppercase tracking-wide">{r.status}</span>
                    </div>
                    <p className="mt-1 text-slate-400">{r.description}</p>
                    {r.evidence && <p className="mt-1 font-mono text-[11px] text-slate-500">{r.evidence}</p>}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        {activeTab === 'coordination' && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-xs">
            <h2 className="text-sm font-semibold text-white flex items-center space-x-2 mb-2">
              <FileText className="w-4 h-4 text-indigo-400" />
              <span>COORDINATION.md</span>
            </h2>
            <pre className="whitespace-pre-wrap font-mono text-[11px] text-slate-400 max-h-[60vh] overflow-auto">
              {coordinationContent || 'Loading coordination document…'}
            </pre>
          </div>
        )}

        {activeTab === 'export' && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-xs text-slate-300 space-y-2">
            <h2 className="text-sm font-semibold text-white flex items-center space-x-2">
              <Smartphone className="w-4 h-4 text-indigo-400" />
              <span>Phone Export</span>
            </h2>
            <p className="text-slate-400">Use the live report JSON from a completed task run as the hand-off artifact.</p>
            {currentReport ? (
              <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 font-mono text-[10px] overflow-auto max-h-80">
                {JSON.stringify(currentReport, null, 2)}
              </pre>
            ) : (
              <p className="text-slate-500">No report yet. Execute a task first.</p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
