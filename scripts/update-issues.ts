import { features } from "web-features";

import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";

// A special comment in the issue body is used to store the web-features
// ID, <!-- web-features:some-feature -->. Whitespace is allowed wherever
// possible to make the matching less brittle to changes.
const pattern = /<!--\s*web-features\s*:\s*([a-z0-9-]+)\s*-->/g;

// A mapping of Mozilla and WebKit standards positions for features are
// maintained for the web-features explorer. Use that data to skip features that
// have a negative/oppose position, as suggested by Mozilla.
const postitionsUrl =
  "https://raw.githubusercontent.com/web-platform-dx/web-features-explorer/refs/heads/main/additional-data/standard-positions.json";

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
- [web features explorer](https://web-platform-dx.github.io/web-features-explorer/features/${id})
- [webstatus.dev](https://webstatus.dev/features/${id})

<!-- web-features:${id} -->`;
}

// Get a map of features to skip with a reason for logging.
async function getFeaturesToSkip(): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  const resp = await fetch(postitionsUrl);
  if (!resp.ok) {
    throw new Error("TODO");
  }

  const featurePositions = await resp.json();
  for (const [feature, vendorPositions] of Object.entries(featurePositions)) {
    let reason;
    for (const { position, url } of Object.values(vendorPositions)) {
      if (position === "negative" || position === "oppose") {
        const message = `${position} position in ${url}`;
        if (reason) {
          reason = `${reason}; ${message}`;
        } else {
          reason = message;
        }
      }
    }
    if (reason) {
      map.set(feature, reason);
    }
  }

  return map;
}

async function update() {
  const skipFeatures = await getFeaturesToSkip();

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
    const skipReason = skipFeatures.get(id);
    if (skipReason) {
      console.log(`Skipping ${id}. Reason: ${skipReason}`);
      continue;
    }

    if (data.status.baseline) {
      console.log(`Skipping ${id}. Reason: Baseline since ${data.status.baseline_low_date}`);
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
          issue_number: issue.number,
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

  // TODO: close open issues that were skipped / not updated.
}

await update();
