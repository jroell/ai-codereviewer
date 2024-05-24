import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File, Change } from "parse-diff";
import minimatch from "minimatch";

// Fetching inputs from the GitHub action environment
const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

// Initializing GitHub and OpenAI clients
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Interface for pull request details
interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

// Function to get PR details
async function getPRDetails(): Promise<PRDetails> {
  try {
    const { repository, number } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8"));
    const prResponse = await octokit.pulls.get({ owner: repository.owner.login, repo: repository.name, pull_number: number });
    return {
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: number,
      title: prResponse.data.title || "",
      description: prResponse.data.body || ""
    };
  } catch (error) {
    const err = error as Error;
    core.setFailed(`Error fetching PR details: ${err.message}`);
    throw err;
  }
}

// Function to get diff of the PR
async function getDiff(owner: string, repo: string, pull_number: number): Promise<string | null> {
  try {
    const response = await octokit.pulls.get({ owner, repo, pull_number, mediaType: { format: "diff" } }) as any;
    return response.data as string;
  } catch (error) {
    const err = error as Error;
    core.setFailed(`Error fetching diff: ${err.message}`);
    return null;
  }
}

// Function to analyze the code using OpenAI
async function analyzeCode(parsedDiff: File[], prDetails: PRDetails): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];
  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      if (!chunk.changes || chunk.changes.length === 0) continue; // Ensure chunk has changes
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

// Function to create a review prompt for OpenAI
function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise return an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- Do not be nitpicky. Provide only useful and valuable suggestions.
- IMPORTANT: NEVER suggest adding comments to the code.
- IMPORTANT: If applicable, provide a suggestion. Here is an example of how to create a suggestion:
\`\`\`suggestion
				{className: cx("icon", item.icon?.props.className, theme)}
\`\`\`

Review the following code diff in the file "${file.to}" and take the pull request title and description into account when writing the response.

Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes.map(c => `${(c as any).ln ? (c as any).ln : (c as any).ln2} ${c.content}`).join("\n")}
\`\`\`
`;
}

// Function to get AI response from OpenAI
async function getAIResponse(prompt: string): Promise<Array<{ lineNumber: string; reviewComment: string }> | null> {
  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_API_MODEL,
      temperature: 0.2,
      max_tokens: 2000,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      messages: [{ role: "system", content: prompt }]
    });
    const res = response.choices[0].message?.content?.trim() || "[]";
    return JSON.parse(res);
  } catch (error) {
    const err = error as Error;
    core.setFailed(`Error fetching AI response: ${err.message}`);
    return null;
  }
}

// Function to create review comments
function createComment(file: File, chunk: Chunk, aiResponses: Array<{ lineNumber: string; reviewComment: string }>): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap(aiResponse => {
    if (!file.to) return [];
    const lineNumber = parseInt(aiResponse.lineNumber);
    if (isNaN(lineNumber)) return [];
    return { body: aiResponse.reviewComment, path: file.to, line: lineNumber };
  });
}

// Function to create review comments on GitHub
async function createReviewComment(owner: string, repo: string, pull_number: number, comments: Array<{ body: string; path: string; line: number }>): Promise<void> {
  try {
    const reviewComments = comments.map(comment => ({
      path: comment.path,
      body: comment.body,
      line: comment.line
    }));
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      event: "COMMENT",
      comments: reviewComments
    });
  } catch (error) {
    const err = error as Error;
    core.setFailed(`Error creating review comments: ${err.message}`);
  }
}

// Function to get base and head SHA values for a PR
async function getBaseAndHeadShas(owner: string, repo: string, pull_number: number): Promise<{ baseSha: string; headSha: string }> {
  const prResponse = await octokit.pulls.get({ owner, repo, pull_number });
  return {
    baseSha: prResponse.data.base.sha,
    headSha: prResponse.data.head.sha
  };
}

// Main function
async function main() {
  try {
    const prDetails = await getPRDetails();
    let diff: string | null;
    const eventData = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));

    if (eventData.action === "opened") {
      diff = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);
    } else if (eventData.action === "synchronize") {
      const { baseSha, headSha } = await getBaseAndHeadShas(prDetails.owner, prDetails.repo, prDetails.pull_number);
      const response = await octokit.repos.compareCommits({ headers: { accept: "application/vnd.github.v3.diff" }, owner: prDetails.owner, repo: prDetails.repo, base: baseSha, head: headSha });
      diff = String(response.data);
    } else {
      core.info("Unsupported event: " + process.env.GITHUB_EVENT_NAME);
      return;
    }

    if (!diff) {
      core.info("No diff found");
      return;
    }

    const parsedDiff = parseDiff(diff);
    const excludePatterns = core.getInput("exclude").split(",").map(s => s.trim());
    const filteredDiff = parsedDiff.filter(file => !excludePatterns.some(pattern => minimatch(file.to ?? "", pattern)));
    const comments = await analyzeCode(filteredDiff, prDetails);

    if (comments.length > 0) {
      await createReviewComment(prDetails.owner, prDetails.repo, prDetails.pull_number, comments);
    }
  } catch (error) {
    const err = error as Error;
    core.setFailed(`Error in main function: ${err.message}`);
  }
}

// Execute the main function
main().catch(error => {
  const err = error as Error;
  core.setFailed(`Unhandled error: ${err.message}`);
  process.exit(1);
});
