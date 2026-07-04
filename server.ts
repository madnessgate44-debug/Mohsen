import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type, FunctionDeclaration } from "@google/genai";

dotenv.config();

const PORT = 3000;
const app = express();

app.use(express.json({ limit: "50mb" }));

// Initialize Google Gemini SDK securely on the server-side
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// Helper for GitHub requests
async function githubRequest(urlPath: string, token: string, method = "GET", body?: any) {
  const url = urlPath.startsWith("http") ? urlPath : `https://api.github.com${urlPath}`;
  const headers: Record<string, string> = {
    "Authorization": `token ${token}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "mission-runner-backend",
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `GitHub error: HTTP ${res.status}`);
  }
  return data;
}

// 1. GitHub API Proxy Route to avoid CORS issues
app.all("/api/github/*", async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace(/^(token|bearer)\s+/i, "").trim();

  if (!token) {
    res.status(401).json({ error: "Missing GitHub Personal Access Token" });
    return;
  }

  const githubPath = req.url.replace("/api/github", "");
  const method = req.method;
  const body = ["GET", "HEAD"].includes(method) ? undefined : req.body;

  try {
    const data = await githubRequest(githubPath, token, method, body);
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Proxy request failed" });
  }
});

// 2. Server-side AI Agent with GitHub tool-calling capability
const listReposDeclaration: FunctionDeclaration = {
  name: "list_repos",
  description: "Lists the repositories for the authenticated GitHub user.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

const listFilesDeclaration: FunctionDeclaration = {
  name: "list_files",
  description: "Lists files and folders inside a directory in the active repository.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: "The directory path (empty string or '/' for root folder).",
      },
    },
    required: ["path"],
  },
};

const getFileDeclaration: FunctionDeclaration = {
  name: "get_file",
  description: "Retrieves the text content of a file in the active repository.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: "The full relative file path to load (e.g., 'src/App.tsx').",
      },
    },
    required: ["path"],
  },
};

const pushFileDeclaration: FunctionDeclaration = {
  name: "push_file",
  description: "Pushes/updates a file's content directly to the active repository branch.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: "The full target path for the file (e.g. 'src/components/MyComp.tsx').",
      },
      content: {
        type: Type.STRING,
        description: "The complete content to write into the file.",
      },
      commit_msg: {
        type: Type.STRING,
        description: "A short, descriptive commit message explaining the change.",
      },
    },
    required: ["path", "content", "commit_msg"],
  },
};

const createRepoDeclaration: FunctionDeclaration = {
  name: "create_repo",
  description: "Creates a brand new GitHub repository for the user.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: {
        type: Type.STRING,
        description: "The name of the new repository.",
      },
      private: {
        type: Type.BOOLEAN,
        description: "True if the repository should be private, false for public.",
      },
      description: {
        type: Type.STRING,
        description: "An optional description of the repository.",
      },
    },
    required: ["name"],
  },
};

const getCommitsDeclaration: FunctionDeclaration = {
  name: "get_commits",
  description: "Retrieves recent commits in the active repository.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      limit: {
        type: Type.INTEGER,
        description: "The maximum number of commits to fetch (default: 10).",
      },
    },
  },
};

const searchCodeDeclaration: FunctionDeclaration = {
  name: "search_code",
  description: "Searches for files containing a specific keyword inside the repository.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: "The search term or keyword to find.",
      },
    },
    required: ["query"],
  },
};

app.post("/api/ai/chat", async (req, res) => {
  const { messages, token, repo, branch } = req.body;

  if (!token) {
    res.status(400).json({ error: "Connect your GitHub account in Settings first." });
    return;
  }

  try {
    const systemPrompt = `You are the central AI agent inside Mission Control (GitHub Control Panel & AI Developer).
The user is working entirely on their device to control their repositories. You are highly professional, polite, direct, and concise.

CURRENT WORKSPACE CONTEXT:
- Authenticated GitHub User: (active token supplied)
- Active Repository: ${repo || "None selected (ask user to select one first)"}
- Active Branch: ${branch || "main"}

Available tools (use them to perform actions directly on the user's GitHub account):
1. 'list_repos': Get list of repositories.
2. 'list_files': View contents of a path.
3. 'get_file': Fetch and review file code.
4. 'push_file': Write/edit and push file code directly to the active repo.
5. 'create_repo': Create a new repo.
6. 'get_commits': Retrieve commit logs.
7. 'search_code': Search the active repo for a term.

Rules:
- If a repository is selected, you can inspect its files and push changes.
- Always perform the GitHub actions directly via the tools whenever requested. Avoid asking the user to manually perform steps that you have tools for!
- Do not make up mock files. Review real code using 'get_file' or 'list_files' before editing.
- After successfully calling a tool, explain the outcome cleanly.`;

    // Process user messages to match Gemini parts format
    const geminiMessages = messages.map((m: any) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const tools = [
      {
        functionDeclarations: [
          listReposDeclaration,
          listFilesDeclaration,
          getFileDeclaration,
          pushFileDeclaration,
          createRepoDeclaration,
          getCommitsDeclaration,
          searchCodeDeclaration,
        ],
      },
    ];

    let currentTurn = 0;
    const MAX_TURNS = 6;
    let finalResponseText = "";
    let executedToolsLog: string[] = [];

    while (currentTurn < MAX_TURNS) {
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: geminiMessages,
        config: {
          systemInstruction: systemPrompt,
          tools,
        },
      });

      const functionCalls = response.functionCalls;
      if (!functionCalls || functionCalls.length === 0) {
        finalResponseText = response.text || "I've processed your request.";
        break;
      }

      // Append model's functionCall turn
      geminiMessages.push({
        role: "model",
        parts: functionCalls.map((fc) => ({ functionCall: fc })),
      });

      // Execute each function call
      const functionResponses = [];
      for (const call of functionCalls) {
        const { name, args, id } = call;
        let toolResult: any;

        try {
          if (name === "list_repos") {
            const data = await githubRequest("/user/repos?sort=updated&per_page=50", token);
            toolResult = data.map((r: any) => ({
              full_name: r.full_name,
              private: r.private,
              description: r.description,
            }));
            executedToolsLog.push(`Listed repositories.`);
          } else if (name === "list_files") {
            if (!repo) throw new Error("No active repository selected.");
            const folderPath = (args as any).path || "";
            const data = await githubRequest(`/repos/${repo}/contents/${folderPath}?ref=${branch || "main"}`, token);
            toolResult = data.map((item: any) => ({
              name: item.name,
              path: item.path,
              type: item.type,
              size: item.size,
            }));
            executedToolsLog.push(`Listed files in directory "${folderPath}".`);
          } else if (name === "get_file") {
            if (!repo) throw new Error("No active repository selected.");
            const filePath = (args as any).path;
            const fileData = await githubRequest(`/repos/${repo}/contents/${filePath}?ref=${branch || "main"}`, token);
            let decoded = "";
            if (fileData.encoding === "base64") {
              decoded = Buffer.from(fileData.content, "base64").toString("utf-8");
            } else {
              decoded = fileData.content;
            }
            toolResult = { path: filePath, content: decoded, sha: fileData.sha };
            executedToolsLog.push(`Retrieved content of file "${filePath}".`);
          } else if (name === "push_file") {
            if (!repo) throw new Error("No active repository selected.");
            const filePath = (args as any).path;
            const content = (args as any).content;
            const commitMsg = (args as any).commit_msg;

            // Check if file exists to get its SHA
            let sha: string | undefined = undefined;
            try {
              const fileData = await githubRequest(`/repos/${repo}/contents/${filePath}?ref=${branch || "main"}`, token);
              sha = fileData.sha;
            } catch (err) {
              // Ignore, file doesn't exist yet
            }

            const body = {
              message: commitMsg,
              content: Buffer.from(content, "utf-8").toString("base64"),
              branch: branch || "main",
              sha,
            };

            const data = await githubRequest(`/repos/${repo}/contents/${filePath}`, token, "PUT", body);
            toolResult = {
              success: true,
              path: filePath,
              commit_sha: data.commit?.sha,
            };
            executedToolsLog.push(`Successfully pushed file "${filePath}" to branch "${branch}".`);
          } else if (name === "create_repo") {
            const nameArg = (args as any).name;
            const isPrivate = (args as any).private || false;
            const desc = (args as any).description || "";
            const data = await githubRequest("/user/repos", token, "POST", {
              name: nameArg,
              private: isPrivate,
              description: desc,
              auto_init: true,
            });
            toolResult = { full_name: data.full_name, html_url: data.html_url };
            executedToolsLog.push(`Created repository "${data.full_name}".`);
          } else if (name === "get_commits") {
            if (!repo) throw new Error("No active repository selected.");
            const limit = (args as any).limit || 10;
            const data = await githubRequest(`/repos/${repo}/commits?sha=${branch || "main"}&per_page=${limit}`, token);
            toolResult = data.map((c: any) => ({
              sha: c.sha,
              message: c.commit?.message,
              author: c.commit?.author?.name,
              date: c.commit?.author?.date,
            }));
            executedToolsLog.push(`Fetched latest commits.`);
          } else if (name === "search_code") {
            if (!repo) throw new Error("No active repository selected.");
            const query = (args as any).query;
            const [owner, repoName] = repo.split("/");
            const data = await githubRequest(`/search/code?q=${encodeURIComponent(`${query} repo:${repo}`)}`, token);
            toolResult = (data.items || []).map((item: any) => ({
              name: item.name,
              path: item.path,
            }));
            executedToolsLog.push(`Searched code for term "${query}".`);
          } else {
            throw new Error(`Tool "${name}" is not implemented on the server.`);
          }

          functionResponses.push({
            name,
            response: { output: toolResult },
            id,
          });
        } catch (err: any) {
          functionResponses.push({
            name,
            response: { error: err.message || "Failed execution" },
            id,
          });
        }
      }

      // Append function response turn
      geminiMessages.push({
        role: "user",
        parts: functionResponses.map((res) => ({ functionResponse: res })),
      });

      currentTurn++;
    }

    res.json({
      content: finalResponseText,
      executed: executedToolsLog,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "An error occurred with Gemini Agent." });
  }
});

// Serve Frontend Bundle
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
