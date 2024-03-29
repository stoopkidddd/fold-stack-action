/* eslint-disable @typescript-eslint/explicit-function-return-type */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck

import { Octokit } from '@octokit/rest'
import core from '@actions/core'
import { execSync } from 'child_process'
import { createActionAuth } from '@octokit/auth-action'

async function findOpenPRs(octokit, commitSHA) {
  const { data: issues } = await octokit.search.issuesAndPullRequests({
    q: `is:open is:pr ${commitSHA} in:body`
  })

  return issues.items.filter(issue => issue.pull_request)
}

async function getTargetBranch(octokit, prURL) {
  const pr = await octokit.request(prURL)
  return pr.data.base.ref
}

export async function main() {
  console.log('are we in main?')
  core.info('did we make it to main, core')
  try {
    const auth = createActionAuth()
    const authentication = await auth()
    const octokit = new Octokit({ auth: authentication.token })

    const commitSHA = process.env.GITHUB_SHA

    const openPRs = await findOpenPRs(octokit, commitSHA)
    if (openPRs.length === 0) {
      core.info('No open PRs found.')
      return
    }

    const pr = openPRs[0]
    const targetBranch = await getTargetBranch(octokit, pr.pull_request.url)

    if (targetBranch === 'develop') {
      core.info("Final PR found targeting 'develop'. Rebase and merge...")
      execSync(`git fetch origin ${pr.head.ref}`)
      execSync(`git checkout -b pr-${pr.number}-branch FETCH_HEAD`)
      execSync(`git rebase origin/develop`)
      execSync(`git push origin pr-${pr.number}-branch:refs/heads/develop`)
      execSync(
        `gh pr merge --squash --delete-branch --auto -m "Rebased and merged PR into develop" ${pr.number}`
      )
    } else {
      core.info("Target branch is not 'develop'. Merging...")
      execSync(`git fetch origin ${pr.head.ref}`)
      execSync(`git checkout -b pr-${pr.number}-branch FETCH_HEAD`)
      execSync(`git merge --no-ff --no-edit ${commitSHA}`)
      execSync(`git push origin pr-${pr.number}-branch:${targetBranch}`)
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}
