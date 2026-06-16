const express = require("express");
const bodyParser = require("body-parser");
const { WebClient } = require("@slack/web-api");
const { Octokit } = require("@octokit/rest");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = "team_kjGSCHKE5dayGG6MmiEwxA0C";
const VERCEL_PROJECT_ID = "prj_VNZPSBBatjdDFD5UgH71zRgOu4K3";
const OWNER = "ojm44444";

const CHANNELS = {
  "moon-os-support": { repo: "moon-dashboard", mode: "fix" },
  "moon-os-build":   { repo: "moon-dashboard", mode: "build" },
  "memo-build":      { repo: "memo",            mode: "build" },
};

const slack = new WebClient(SLACK_BOT_TOKEN);
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

let channelMap = {}; // name -> { id, repo, mode }
let lastTriageTs = null;

async function resolveChannelIds() {
  const result = await slack.conversations.list({ limit: 200, types: "public_channel,private_channel" });
  for (const channel of result.channels) {
    if (CHANNELS[channel.name]) {
      channelMap[channel.id] = { name: channel.name, ...CHANNELS[channel.name] };
      console.log(`✅ Channel #${channel.name} (${channel.id}) → repo: ${CHANNELS[channel.name].repo}, mode: ${CHANNELS[channel.name].mode}`);
    }
  }
}

async function getRepoFiles(repo = "moon-dashboard") {
  const ignore = ["node_modules", ".git", ".next", "dist", "build"];
  const extensions = [".js", ".jsx", ".ts", ".tsx", ".css", ".json", ".md"];
  const files = [];

  async function listDir(dirPath) {
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo, path: dirPath });
    for (const item of data) {
      if (ignore.some(ig => item.name === ig)) continue;
      if (item.type === "dir") {
        await listDir(item.path);
      } else if (extensions.includes(path.extname(item.name))) {
        files.push(item.path);
      }
    }
  }

  await listDir("");
  return files.slice(0, 25);
}

async function getFileContent(filePath, repo = "moon-dashboard") {
  try {
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo, path: filePath });
    return Buffer.from(data.content, "base64").toString("utf8").slice(0, 2000);
  } catch (_) {
    return "";
  }
}

async function runClaudeAndPR(taskDescription, channel, label, repo = "moon-dashboard") {
  const branch = `ai-${Date.now()}`;

  // Get main branch SHA
  const { data: refData } = await octokit.git.getRef({ owner: OWNER, repo, ref: "heads/main" });
  const mainSha = refData.object.sha;

  // Create new branch
  await octokit.git.createRef({ owner: OWNER, repo, ref: `refs/heads/${branch}`, sha: mainSha });

  // Get repo context
  const filePaths = await getRepoFiles(repo);
  let repoContext = "";
  for (const fp of filePaths) {
    const content = await getFileContent(fp, repo);
    if (content) repoContext += `\n\n--- ${fp} ---\n${content}`;
  }

  console.log("Calling Claude API...");
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: `You are working on the ${repo} app. Here are the current files:\n${repoContext}\n\nTask: ${taskDescription}\n\nRespond with ONLY the files to create or modify. For each file use this exact format:\n\n<file path="relative/path/to/file.tsx">\nfile contents here\n</file>\n\nDo not explain, just output the file blocks.`
    }]
  });

  const responseText = message.content[0].text;
  const fileMatches = [...responseText.matchAll(/<file path="([^"]+)">([\s\S]*?)<\/file>/g)];

  if (fileMatches.length === 0) {
    await slack.chat.postMessage({ channel, text: `⚠️ Claude didn't produce any file changes for: "${label}"` });
    return;
  }

  // Commit each file via GitHub API
  for (const [, filePath, fileContent] of fileMatches) {
    const content = fileContent.trim();
    const encoded = Buffer.from(content).toString("base64");

    // Check if file exists (to get SHA for update)
    let fileSha;
    try {
      const { data } = await octokit.repos.getContent({ owner: OWNER, repo, path: filePath, ref: branch });
      fileSha = data.sha;
    } catch (_) {}

    await octokit.repos.createOrUpdateFileContents({
      owner: OWNER, repo,
      path: filePath,
      message: `AI: ${label.substring(0, 60)}`,
      content: encoded,
      branch,
      ...(fileSha ? { sha: fileSha } : {}),
    });
    console.log(`✅ Committed ${filePath} to ${repo}`);
  }

  const pr = await octokit.pulls.create({
    owner: OWNER, repo,
    title: `AI: ${label.substring(0, 60)}`,
    head: branch, base: "main",
    body: `Automated change from Slack.\n\nTask:\n> ${label}`,
  });

  // Auto-merge the PR
  const mergeResult = await octokit.pulls.merge({
    owner: OWNER, repo,
    pull_number: pr.data.number,
    merge_method: "squash",
  });
  const mergeCommitSha = mergeResult.data.sha;

  await slack.chat.postMessage({ channel, text: `🔀 PR merged — waiting for Vercel deploy...\n${pr.data.html_url}` });

  // Only watch Vercel for moon-dashboard (memo may not be on Vercel)
  if (repo === "moon-dashboard" && VERCEL_TOKEN) {
    watchVercelDeploy(channel, mergeCommitSha, pr.data.html_url).catch(console.error);
  }
}

async function watchVercelDeploy(channel, commitSha, prUrl) {
  // Wait for Vercel to pick up the commit
  await new Promise(r => setTimeout(r, 15000));

  const maxAttempts = 24; // 24 * 15s = 6 minutes
  let deploymentId = null;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 15000));

    try {
      const resp = await fetch(
        `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT_ID}&teamId=${VERCEL_TEAM_ID}&limit=5`,
        { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
      );
      const data = await resp.json();
      const deployments = data.deployments || [];

      // Find the deployment matching our commit
      const match = deployments.find(d =>
        d.meta?.githubCommitSha === commitSha || d.target === "production"
      );

      if (!match) continue;
      deploymentId = match.uid || match.id;

      if (match.state === "READY") {
        await slack.chat.postMessage({
          channel,
          text: `✅ Deployed successfully! Live now.\n${prUrl}`,
        });
        return;
      }

      if (match.state === "ERROR" || match.state === "CANCELED") {
        // Fetch build logs
        let logSnippet = "";
        try {
          const logResp = await fetch(
            `https://api.vercel.com/v2/deployments/${deploymentId}/events?teamId=${VERCEL_TEAM_ID}&limit=50`,
            { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
          );
          const events = await logResp.json();
          const errors = (Array.isArray(events) ? events : [])
            .filter(e => e.type === "stderr" || (e.payload?.text && /error/i.test(e.payload.text)))
            .slice(-10)
            .map(e => e.payload?.text || e.text || "")
            .filter(Boolean)
            .join("\n");
          if (errors) logSnippet = `\n\nBuild errors:\n\`\`\`\n${errors.slice(0, 800)}\n\`\`\``;
        } catch (_) {}

        await slack.chat.postMessage({
          channel,
          text: `❌ Deploy FAILED — reverting the merge now.${logSnippet}\n${prUrl}`,
        });

        // Revert by creating a revert commit
        try {
          const { data: mainRef } = await octokit.git.getRef({ owner: OWNER, repo: "moon-dashboard", ref: "heads/main" });
          const currentSha = mainRef.object.sha;
          const { data: currentCommit } = await octokit.git.getCommit({ owner: OWNER, repo: "moon-dashboard", commit_sha: currentSha });
          const parentSha = currentCommit.parents[0]?.sha;

          if (parentSha) {
            const revertBranch = `revert-${Date.now()}`;
            await octokit.git.createRef({ owner: OWNER, repo: "moon-dashboard", ref: `refs/heads/${revertBranch}`, sha: parentSha });
            const revertPr = await octokit.pulls.create({
              owner: OWNER, repo: "moon-dashboard",
              title: `Revert: failed deploy`,
              head: revertBranch, base: "main",
              body: `Auto-revert of ${prUrl} which caused a Vercel build failure.`,
            });
            await octokit.pulls.merge({
              owner: OWNER, repo: "moon-dashboard",
              pull_number: revertPr.data.number,
              merge_method: "merge",
            });
            await slack.chat.postMessage({
              channel,
              text: `↩️ Reverted. Main branch is back to the previous state.\n${revertPr.data.html_url}`,
            });
          }
        } catch (revertErr) {
          await slack.chat.postMessage({
            channel,
            text: `⚠️ Could not auto-revert: ${revertErr.message} — please check manually.`,
          });
        }
        return;
      }

      // Still building — keep polling
      console.log(`Vercel deploy ${deploymentId} state: ${match.state} (attempt ${i + 1})`);
    } catch (err) {
      console.error("Vercel poll error:", err.message);
    }
  }

  await slack.chat.postMessage({
    channel,
    text: `⏱️ Deploy is taking longer than expected — check Vercel manually.\n${prUrl}`,
  });
}

async function triageErrors(channel) {
  // Fetch messages from channel — all if first run, else since last triage
  const params = { channel, limit: 200 };
  if (lastTriageTs) params.oldest = lastTriageTs;

  const result = await slack.conversations.history(params);
  const messages = result.messages || [];

  // Filter out bot messages and triage commands
  const errors = messages
    .filter(m => !m.bot_id && !m.text.toLowerCase().startsWith("triage"))
    .map(m => m.text)
    .filter(t => t && t.trim().length > 10)
    .reverse(); // oldest first

  if (errors.length === 0) {
    await slack.chat.postMessage({ channel, text: `✅ No new errors since last triage!` });
    return;
  }

  await slack.chat.postMessage({ channel, text: `🔍 Found ${errors.length} error(s) — analysing and triaging...` });

  // Ask Claude to triage
  const triageMessage = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [{
      role: "user",
      content: `You are triaging errors for the moon-dashboard app. Here are the errors reported:\n\n${errors.map((e, i) => `${i + 1}. ${e}`).join("\n\n")}\n\nPlease:\n1. Remove duplicates\n2. Rank by severity (Critical / High / Medium / Low)\n3. Give a one-line summary of each unique issue\n4. List which ones you will fix (top 3 max)\n\nFormat as a clean Slack message.`
    }]
  });

  const summary = triageMessage.content[0].text;
  await slack.chat.postMessage({ channel, text: summary });

  // Fix top 3 unique errors
  const fixMessage = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: `From these errors in the moon-dashboard app:\n\n${errors.join("\n\n")}\n\nList the top 3 most important unique issues to fix, one per line. Just the issue description, nothing else.`
    }]
  });

  const toFix = fixMessage.content[0].text.split("\n").filter(l => l.trim()).slice(0, 3);
  lastTriageTs = String(Date.now() / 1000);

  for (const issue of toFix) {
    await slack.chat.postMessage({ channel, text: `🔧 Fixing: ${issue}` });
    try {
      await runClaudeAndPR(issue, channel, issue);
    } catch (err) {
      await slack.chat.postMessage({ channel, text: `❌ Could not fix: ${err.message}` });
    }
  }
}

app.post("/slack/events", async (req, res) => {
  if (req.body.challenge) return res.send(req.body.challenge);

  const event = req.body.event;
  if (!event || !event.text || event.bot_id) return res.sendStatus(200);

  const ch = channelMap[event.channel];
  if (!ch) return res.sendStatus(200); // not a channel we care about

  const text = event.text;
  const textLower = text.toLowerCase();
  const isMentioned = text.includes("<@U0BB2LN6AKB>");

  // Fix channel: triage command or task keywords/mentions
  if (ch.mode === "fix") {
    const isTriageCommand = textLower.trim() === "triage";
    const isTaskCommand = isMentioned ||
      textLower.startsWith("build") || textLower.startsWith("fix") ||
      textLower.startsWith("add") || textLower.startsWith("create");

    if (isTriageCommand) {
      console.log("Triage requested");
      res.sendStatus(200);
      try {
        await triageErrors(event.channel);
      } catch (err) {
        console.error(err);
        await slack.chat.postMessage({ channel: event.channel, text: `❌ Triage failed: ${err.message}` });
      }
      return;
    }

    if (!isTaskCommand) return res.sendStatus(200);
  }

  // Build channels: only trigger when bot is mentioned
  if (!isMentioned) return res.sendStatus(200);

  console.log(`Task received in #${ch.name} (${ch.repo}):`, text);
  res.sendStatus(200);

  try {
    let contextBlock = "";
    try {
      const history = await slack.conversations.history({ channel: event.channel, limit: 20 });
      const recentMessages = (history.messages || [])
        .filter(m => !m.bot_id)
        .reverse()
        .map(m => m.text)
        .join("\n");
      if (recentMessages) contextBlock = `\n\nRecent channel context:\n${recentMessages}`;
    } catch (_) {}

    await slack.chat.postMessage({ channel: event.channel, text: `🤖 On it! (→ ${ch.repo})` });
    await runClaudeAndPR(text + contextBlock, event.channel, text, ch.repo);
  } catch (err) {
    console.error(err);
    await slack.chat.postMessage({ channel: event.channel, text: `❌ Something went wrong: ${err.message}` });
  }
});

app.listen(3000, async () => {
  console.log("🚀 MoonOS Autopilot running on port 3000");
  await resolveChannelIds();
});
