import { features } from "web-features";

import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";

// A special comment in the issue body is used to store the web-features
// ID, <!-- web-features:some-feature -->. Whitespace is allowed wherever
// possible to make the matching less brittle to changes.
const pattern = /<!--\s*web-features\s*:\s*([a-z0-9-]+)\s*-->/g;

async function* iterateIssues(octokit, params) {
  for await (const response of octokit.paginate.iterator(
    octokit.rest.issues.listForRepo,
    {
      ...params,
      per_page: 100,
    },
  )) {
    for (const issue of response.data) {
      yield issue;
    }
  }
}

function escape(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

function issueBody(id, data) {
  return `${data.description_html}

Specification: ${data.spec}

For more details on this feature:

${data.caniuse ? `- [caniuse.com](https://caniuse.com/${data.caniuse})` : ""}
- [web features explorer](https://web-platform-dx.github.io/web-features-explorer/${id})
- [webstatus.dev](https://webstatus.dev/features/${id})

<!-- web-features:${id} -->`;
}

async function update() {
  const ThrottlingOctokit = Octokit.plugin(throttling);

  const octokit = new ThrottlingOctokit({
    auth: process.env.GITHUB_TOKEN,
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(
          `Rate limit hit for request ${options.method} ${options.url}`,
        );

        if (retryCount < 3) {
          octokit.log.info(`Retrying after ${retryAfter} seconds`);
          return true;
        }
      },
      onSecondaryRateLimit: (retryAfter, options, octokit) => {
        octokit.log.warn(
          `Secondary rate limit hit for request ${options.method} ${options.url}`,
        );
      },
    },
  });

  const params = {
    owner: "web-platform-dx",
    repo: "developer-signals",
  };

  // Iterate existing issues and create a map from web-features ID to
  // the issue. This is in order to not create duplicate issues.
  const openIssues = new Map();
  for await (const issue of iterateIssues(octokit, params)) {
    const m = pattern.exec(issue.body);
    if (m) {
      openIssues.set(m[1], issue);
    }
  }

  // TODO: sort features by age so that issues for older features are created
  // first. This matters mostly for the initial batch creation of issues.

  for (const [id, data] of Object.entries(features)) {
    if (data.status.baseline === "high") {
      // TODO: close issues for features as they reach Baseline widely available?
      continue;
    }

    const title = escape(data.name);
    const body = issueBody(id, data);

    const issue = openIssues.get(id);
    if (issue) {
      if (issue.title !== title || issue.body !== body) {
        // Update the issue. This might happen as a result of a change in
        // web-features or if we change the format of the issue body.
        await octokit.rest.issues.update({
          ...params,
          issue_number: issue.data.issue_number,
          title,
          body,
        });
      }
    } else {
      // Create a new issue.
      await octokit.rest.issues.create({
        ...params,
        title,
        body,
        labels: ["feature"],
      });
    }
  }
}

await update();
