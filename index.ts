import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { search } from "./searxng.js";
import { fetchContent } from "./extract.js";
import { isGitHubUrl, cloneRepo } from "./github.js";

const searchCache = new Map<string, { query: string; results: any[] }>();

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatSearchResults(results: any[]): string {
  if (results.length === 0) return "No results found.";
  return results.map((r, i) => 
    `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet.slice(0, 200)}${r.snippet.length > 200 ? "..." : ""}`
  ).join("\n\n");
}

function formatRepoFiles(files: any[]): string {
  return files.slice(0, 30).map(f => `- ${f.path}`).join("\n") + 
    (files.length > 30 ? `\n... and ${files.length - 30} more files` : "");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using SearXNG",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results", default: 10 }))
    }),
    
    async execute(_id, params, signal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Aborted" }] };
      }
      
      try {
        const { results } = await search(params.query, params.limit);
        const searchId = generateId();
        searchCache.set(searchId, { query: params.query, results });
        
        return {
          content: [{ type: "text", text: formatSearchResults(results) }],
          details: { searchId, resultCount: results.length, query: params.query, results }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: String(err) }
        };
      }
    },
    
    renderCall(args, theme) {
      const q = (args as any).query || "";
      const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
      return new Text(theme.fg("toolTitle", "search ") + theme.fg("accent", `"${display}"`), 0, 0);
    },
    
    renderResult(result, { expanded }, theme) {
      const details = result.details as any;
      if (details?.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }
      const results = details?.results || [];
      const count = results.length;
      if (count === 0) {
        return new Text(theme.fg("dim", "No results found."), 0, 0);
      }

      let text = theme.fg("success", `${count} result${count !== 1 ? "s" : ""} for `) + theme.fg("accent", `"${details.query}"`);
      const maxDisplay = expanded ? count : Math.min(count, 5);
      for (let i = 0; i < maxDisplay; i++) {
        const r = results[i];
        const num = theme.fg("accent", `${i + 1}.`);
        const title = theme.fg("text", ` ${r.title}`);
        const url = theme.fg("mdLink", ` ${r.url}`);
        const snippet = theme.fg("dim", ` ${r.snippet.slice(0, expanded ? 300 : 150)}`);
        text += `\n${num}${title}\n${url}\n${snippet}`;
      }
      if (!expanded && count > maxDisplay) {
        text += `\n${theme.fg("dim", `... and ${count - maxDisplay} more result${count - maxDisplay !== 1 ? "s" : ""} (searchId: ${details.searchId})`)}`;
      }
      return new Text(text, 0, 0);
    }
  });

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description: "Fetch URL content. Automatically clones GitHub repos.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" })
    }),
    
    async execute(_id, params, signal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Aborted" }] };
      }

      if (isGitHubUrl(params.url)) {
        const repo = await cloneRepo(params.url);
        
        if (!repo) {
          return {
            content: [{ type: "text", text: "Failed to clone repository" }],
            details: { error: "Clone failed" }
          };
        }
        
        const output = `## Repository Cloned\n\n**Path:** \`${repo.localPath}\`\n\n**Files (${repo.files.length}):**\n${formatRepoFiles(repo.files)}\n\n---\n\nUse \`read\` tool to explore files.`;
        
        return {
          content: [{ type: "text", text: output }],
          details: { 
            localPath: repo.localPath, 
            fileCount: repo.files.length,
            files: repo.files.slice(0, 10).map(f => f.path)
          }
        };
      }

      const result = await fetchContent(params.url);
      
      if (result.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          details: { error: result.error }
        };
      }
      
      const truncated = result.content.length > 30000;
      const content = truncated 
        ? result.content.slice(0, 30000) + "\n\n[Content truncated...]"
        : result.content;
      
      return {
        content: [{ type: "text", text: content }],
        details: { 
          title: result.title, 
          url: result.url, 
          truncated,
          length: result.content.length 
        }
      };
    },
    
    renderCall(args, theme) {
      const url = (args as any).url || "";
      const isGH = isGitHubUrl(url);
      const display = url.length > 50 ? url.slice(0, 47) + "..." : url;
      const prefix = isGH ? "clone " : "fetch ";
      const color = isGH ? "warning" : "accent";
      return new Text(theme.fg("toolTitle", prefix) + theme.fg(color, display), 0, 0);
    },
    
    renderResult(result, { expanded }, theme) {
      const details = result.details as any;
      if (details?.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }
      if (details?.localPath) {
        return new Text(
          theme.fg("success", "✓ cloned ") +
          theme.fg("muted", `${details.fileCount} files at `) +
          theme.fg("accent", details.localPath),
          0, 0
        );
      }
      const content = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      if (expanded && content) {
        const title = details?.title ? theme.fg("accent", `## ${details.title}`) : "";
        const url = details?.url ? theme.fg("mdLink", `Source: ${details.url}`) : "";
        return new Text(`${title}\n${url}\n\n${content}`, 0, 0);
      }
      const length = details?.length || content.length;
      const title = details?.title ? ` "${details.title}"` : "";
      return new Text(
        theme.fg("success", `✓ fetched${title}`) +
        theme.fg("muted", ` (${length} chars)`) +
        (details?.truncated ? theme.fg("warning", " [truncated]") : "")
      );
    }
  });

  pi.registerTool({
    name: "get_search_results",
    label: "Get Search Results",
    description: "Retrieve previous search results by ID",
    parameters: Type.Object({
      searchId: Type.String()
    }),
    
    async execute(_id, params) {
      const cached = searchCache.get(params.searchId);
      if (!cached) {
        return { content: [{ type: "text", text: "Search not found" }] };
      }
      return {
        content: [{ type: "text", text: `Query: "${cached.query}"\n\n${formatSearchResults(cached.results)}` }]
      };
    }
  });
}
