import { mkdir, writeFile } from "node:fs/promises";
import { browsers, features } from "web-features";
import dedent from "dedent";

import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";

const dryRun = process.argv.includes("--dry-run");

// A special comment in the issue body is used to store the web-features
// ID, <!-- web-features:some-feature -->. Whitespace is allowed wherever
// possible to make the matching less brittle to changes.
const pattern = /<!--\s*web-features\s*:\s*([a-z0-9-]+)\s*-->/;

// Features with negative standards positions are very unlikely to ever progress
// to Baseline, and we made a decision not to collect dev signals about them
// here on this repo. If any of the features we iterate on in this script has a
// standards position that matches the below strings, we skip the feature. Note
// that Mozilla uses "negative" while WebKit uses "oppose".
//
// TODO: Migrate to NPM package once published:
// https://github.com/web-platform-dx/web-features-mappings/issues/5
const mappingsUrl =
  "https://raw.githubusercontent.com/web-platform-dx/web-features-mappings/refs/heads/main/mappings/combined-data.json";

const imgDir =
  "https://raw.githubusercontent.com/web-platform-dx/developer-signals/refs/heads/main/img";

interface VendorPosition {
  vendor: "mozilla" | "webkit";
  url: string;
  position:
    | ""
    | "positive"
    | "support"
    | "oppose"
    | "defer"
    | "neutral"
    | "negative"
    | "blocked";
}

type MappingsData = Record<
  string,
  {
    "standards-positions"?: VendorPosition[];
  }
>;

const positionsToIgnore: VendorPosition["position"][] = ["negative", "oppose"];

interface IterateIssuesParams {
  owner: string;
  repo: string;
}

async function* iterateIssues(octokit: Octokit, params: IterateIssuesParams) {
  for await (const response of octokit.paginate.iterator(
    octokit.rest.issues.listForRepo,
    {
      ...params,
      labels: ["feature"],
      per_page: 100,
    },
  )) {
    for (const issue of response.data) {
      yield issue;
    }
  }
}

const dateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeZone: "UTC",
});

function issueBody(id: string, data: (typeof features)[string]) {
  const supportSummary: Record<string, boolean> = {};
  const supportLines = [];
  for (const [browser, { name, releases }] of Object.entries(browsers)) {
    const version = data.status.support[browser as keyof typeof browsers];
    const v = version?.replace("≤", "");
    const baseBrowser = browser.split("_")[0]; // browser without OS
    supportSummary[vendor] ??= true;
    supportSummary[vendor] = supportSummary[vendor] && !!v;
    if (v) {
      const date = releases.find((r) => r.version === v)!.date;
      const dateString = dateFormat.format(new Date(date));
      supportLines.push(`${name} ${version} (${dateString})`);
    } else {
      supportLines.push(`${name}: not supported`);
    }
  }
  const supportIcons = Object.entries(supportSummary).map(([vendor, available]) => {
    const availability = available ? "available" : "unavailable";
    return `<img src="${imgDir}/${vendor}.svg" alt="${vendor}"><img src="${imgDir}/${availability}.svg" alt="${availability}">`;
  });
  const supportBlock = dedent`
    <details>
    <summary>${supportIcons.join(" ")}</summary>

    ${supportLines.map((l) => `- ${l}`).join("\n")}
    </details>
  `;

  // TODO: include MDN links (before caniuse link) when we have web-features-mappings
  // as a dependency (see above).
  return dedent`
    _This GitHub issue is for collecting web developer signals for ${data.name}._

    ${data.description_html}

    ## Browser support

    ${supportBlock}

    ## Give us feedback

    If you're pressed for time, but you want this feature to be available in all browsers, please give this issue a thumbs up 👍 reaction.

    However, a much better guide for us is to know how you'd use this feature, and what you're having to do in the meantime. This helps us judge the priority versus other features.

    Copy the template below in a comment, and add the details that matter to _you_.

    \`\`\`md
    ## What I want to do with this feature

    <!-- Add your specific use-cases, even if they seem obvious to you. -->

    ## What I'm having to do in the meantime

    <!--
    Are you having to use another feature instead, a polyfill, or is it blocking you completely?
    Why are the alternatives worse than using this feature?
    -->
    \`\`\`

    All comments are expected to adhere to the [Code of Conduct](https://github.com/web-platform-dx/developer-signals/blob/main/CODE_OF_CONDUCT.md).

    ## Learn more

    You can learn more about this feature here:

    ${data.caniuse ? `- [caniuse.com](https://caniuse.com/${data.caniuse})` : ""}
    - [web features explorer](https://web-platform-dx.github.io/web-features-explorer/features/${id})
    - [webstatus.dev](https://webstatus.dev/features/${id})
    - [Specification](${data.spec})

    <!-- web-features:${id} -->
  `;
}

// Get a map of features to skip with a reason for logging.
async function getFeaturesToSkip(): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  const resp = await fetch(mappingsUrl);
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${mappingsUrl}: ${resp.statusText}`);
  }

  const mappings = (await resp.json()) as MappingsData;
  for (const [feature, data] of Object.entries(mappings)) {
    const positions = data["standards-positions"];
    if (!positions) {
      continue;
    }
    let reason;
    for (const { vendor, position, url } of positions) {
      if (position && positionsToIgnore.includes(position)) {
        const message = `${vendor} position is ${position}: ${url}`;
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

  // Based on https://github.com/octokit/plugin-throttling.js/blob/main/README.md
  const octokit = new ThrottlingOctokit({
    auth: process.env.GITHUB_TOKEN,
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(
          `Request quota exhausted for request ${options.method} ${options.url}`,
        );

        if (retryCount < 1) {
          // only retries once
          octokit.log.info(`Retrying after ${retryAfter} seconds!`);
          return true;
        }
      },
      onSecondaryRateLimit: (retryAfter, options, octokit) => {
        // does not retry, only logs a warning
        octokit.log.warn(
          `SecondaryRateLimit detected for request ${options.method} ${options.url}`,
        );
      },
    },
  });

  const params = {
    owner: "web-platform-dx",
    repo: "developer-signals",
  };

  // Build up a manifest mapping ID to issue.
  const manifest = new Map<string, object>();

  // Iterate existing issues and create a map from web-features ID to
  // the issue. This is in order to not create duplicate issues.
  const openIssues = new Map<string, any>();
  for await (const issue of iterateIssues(octokit, params)) {
    if (typeof issue === "string") {
      throw Error(`Unexpected issue type (string)`);
    }

    if (
      !("body" in issue && "html_url" in issue) ||
      typeof issue.body !== "string" ||
      typeof issue.html_url !== "string"
    ) {
      throw Error(
        `Unexpected issue type (missing body or html_url, or not strings)`,
      );
    }

    const m = pattern.exec(issue.body);

    if (m) {
      let id = m[1];
      // If the feature has been moved, change the ID to the new ID so that this
      // issue will be found when iterating all features.
      if (features[id]?.kind === "moved") {
        id = features[id].redirect_target;
      }
      if (openIssues.has(id)) {
        throw new Error(
          `Multiple issues for ${id}: ${openIssues.get(id).html_url} and ${issue.html_url}`,
        );
      }
      openIssues.set(id, issue);
    }
  }

  // Sort features by earliest release date in any browser, using subsequent shipping
  // dates as tie breakers. Features that aren't shipped in any browser come last.
  const sortKeys = new Map<string, string>();
  for (const [id, data] of Object.entries(features)) {
    switch (data.kind) {
      case "feature":
        // Normal feature, handled below.
        break;
      case "moved":
        // Moves are handled when populating the openIssues map.
        continue;
      case "split":
        // TODO: Handle split features. The new features will be automatically
        // created, but we should close the original feature with a comment
        // pointing to the new ones.
        continue;
      default:
        throw new Error(`Unknown feature kind: ${data.kind}`);
    }

    const dates: string[] = [];
    for (const [browser, version] of Object.entries(data.status.support)) {
      const v = version.replace("≤", "");
      const release = browsers[browser as keyof typeof browsers].releases.find(
        (r) => r.version === v,
      );
      if (release) {
        dates.push(release.date);
      }
    }
    // Add a date-like string that will sort after any real date as a tiebreaker
    // when N dates are the same and one feature has more than N dates. This
    // also ensures that features that aren't shipped sort last.
    dates.push("9999-99-99");
    dates.sort();
    sortKeys.set(id, dates.join("+"));
  }
  const sortedIds = Array.from(sortKeys.keys()).sort((a, b) => {
    return sortKeys.get(a)!.localeCompare(sortKeys.get(b)!);
  });

  for (const id of sortedIds) {
    const data = features[id];

    if (!data) {
      console.log(`Skipping ${id}. Reason: not in web-features`);
      continue;
    }

    const skipReason = skipFeatures.get(id);
    if (skipReason) {
      // TODO: Handle skipped features that already have open issues.
      console.log(`Skipping ${id}. Reason: ${skipReason}`);
      continue;
    }

    if (data.discouraged) {
      // TODO: Handle skipped features that already have open issues.
      console.log(
        `Skipping ${id}. Reason: Discouraged according to ${data.discouraged.according_to[0]}`,
      );
      continue;
    }

    const title = data.name;
    const body = issueBody(id, data);
    const issue = openIssues.get(id);

    if (data.status.baseline && !issue) {
      console.log(
        `Skipping ${id}. Reason: Baseline since ${data.status.baseline_low_date}`,
      );
      continue;
    }

    if (issue) {
      if (issue.title !== title || issue.body !== body) {
        // Update the issue. This might happen as a result of a change in
        // web-features or if we change the format of the issue body.
        if (dryRun) {
          console.log(`Dry run. Would update issue for ${id}.`);
          continue;
        }
        console.log(`Updating issue for ${id}.`);
        await octokit.rest.issues.update({
          ...params,
          issue_number: issue.number,
          title,
          body,
          // Labels are not updated to avoid removing labels added manually.
        });
      } else {
        console.log(`Issue for ${id} is up-to-date.`);
      }
      manifest.set(id, {
        url: issue.html_url,
        // Only count 👍 reactions as "votes".
        votes: issue.reactions["+1"],
      });
    } else {
      // Create a new issue.
      if (dryRun) {
        console.log(`Dry run. Would create new issue for ${id}.`);
        continue;
      }
      console.log(`Creating new issue for ${id}.`);
      const response = await octokit.rest.issues.create({
        ...params,
        title,
        body,
        labels: ["feature"],
      });
      manifest.set(id, {
        url: response.data.html_url,
        votes: 0,
      });
    }
  }

  // Serialize the manifest to a JSON object with sorted keys.
  const ids = Array.from(manifest.keys()).sort();
  const manifestJson = JSON.stringify(
    Object.fromEntries(ids.map((id) => [id, manifest.get(id)])),
  );
  // Note: Uses recursive so that it doesn't fail if out/ exists.
  await mkdir("out", { recursive: true });
  await writeFile("out/web-features-signals.json", manifestJson);
  console.log("Wrote web-features-signals.json");

  // TODO: close open issues that were skipped / not updated.
}

await update();
