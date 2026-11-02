package main

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// fs/gitLog — a file's revisions, newest first: the commits that touched it
// (`git log --follow`, so a rename keeps its history) and, asked for, the file's
// text at each (`git show <sha>:<path at that commit>`). Read-only; the display's
// depth layers (a code pin's past behind its page) read it. Like fs/gitDiff the
// relay stays transport: raw commit facts and raw file text, no semantics.

// gitLogParams is the body of fs/gitLog. URI names the file as every fs RPC
// does (file:// or a project-relative path); it must resolve inside the project
// root (git runs there). N caps the commits (default gitLogDefaultN, at most
// gitLogMaxN); Text asks for each revision's file text.
type gitLogParams struct {
	URI  string `json:"uri"`
	N    int    `json:"n"`
	Text bool   `json:"text"`
}

// gitLogCommit is one revision of the file. Path is the file's repo-relative
// name AT that commit (it differs across a rename). Text is the file there
// (only when asked, and only while the response stays under its text cap —
// TextOmitted says a revision's text was left out for size).
type gitLogCommit struct {
	SHA         string   `json:"sha"`
	Parents     []string `json:"parents"`
	Time        int64    `json:"time"` // author time, unix ms
	Author      string   `json:"author"`
	Subject     string   `json:"subject"`
	Path        string   `json:"path"`
	Text        *string  `json:"text,omitempty"`
	TextOmitted bool     `json:"textOmitted,omitempty"`
}

// gitLogResult is the fs/gitLog response. Path is the file's repo-relative name
// now; an untracked file answers with no commits (not an error).
type gitLogResult struct {
	Root    string         `json:"root"`
	Path    string         `json:"path"`
	Commits []gitLogCommit `json:"commits"`
}

const (
	gitLogDefaultN = 5
	gitLogMaxN     = 50
)

// maxGitLogTextBytes caps the revision text one fs/gitLog response carries
// (the same budget as a git diff); past it, later revisions come without text.
var maxGitLogTextBytes = maxDiffBytes

// handleGitLog answers fs/gitLog. Failures surface git's own stderr.
func (h *FSHandler) handleGitLog(write writeFn, id json.RawMessage, raw json.RawMessage) {
	var p gitLogParams
	if err := json.Unmarshal(raw, &p); err != nil || p.URI == "" {
		h.sendRPCError(write, id, -32602, "invalid params: fs/gitLog wants {uri, n?, text?}", nil)
		return
	}
	n := p.N
	if n <= 0 {
		n = gitLogDefaultN
	}
	if n > gitLogMaxN {
		h.sendRPCError(write, id, -32602, "n is at most "+strconv.Itoa(gitLogMaxN), map[string]int{"n": p.N})
		return
	}
	resolved, err := h.resolvePath(p.URI)
	if err != nil {
		h.sendRPCError(write, id, -32602, err.Error(), map[string]string{"uri": p.URI})
		return
	}
	rel, err := filepath.Rel(h.root, resolved)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		h.sendRPCError(write, id, -32602, "fs/gitLog reads files inside the project root: "+p.URI, map[string]string{"root": h.root})
		return
	}
	rel = filepath.ToSlash(rel)
	// One record per commit: \x1e, then the header fields \x1f-separated, then
	// --name-only's line — the file's name at that commit.
	out, err := exec.Command("git", "-C", h.root, "log", "--follow", "--no-color",
		"--format=%x1e%H%x1f%P%x1f%at%x1f%an%x1f%s", "--name-only", "-n", strconv.Itoa(n), "--", rel).Output()
	if err != nil {
		h.sendRPCError(write, id, -32000, "git log: "+gitStderr(err), map[string]string{"path": rel})
		return
	}
	commits := parseGitLog(string(out))
	if p.Text {
		budget := maxGitLogTextBytes
		for i := range commits {
			c := &commits[i]
			if budget <= 0 {
				c.TextOmitted = true
				continue
			}
			body, err := exec.Command("git", "-C", h.root, "show", c.SHA+":"+c.Path).Output()
			if err != nil {
				h.sendRPCError(write, id, -32000, "git show "+c.SHA+":"+c.Path+": "+gitStderr(err), nil)
				return
			}
			if len(body) > budget {
				c.TextOmitted = true
				budget = 0
				continue
			}
			s := string(body)
			c.Text = &s
			budget -= len(body)
		}
	}
	h.sendRPCResult(write, id, gitLogResult{Root: h.root, Path: rel, Commits: commits})
}

// parseGitLog reads `git log --format=%x1e%H%x1f%P%x1f%at%x1f%an%x1f%s
// --name-only` output into commits, newest first.
func parseGitLog(out string) []gitLogCommit {
	commits := []gitLogCommit{}
	for _, rec := range strings.Split(out, "\x1e") {
		rec = strings.TrimSpace(rec)
		if rec == "" {
			continue
		}
		lines := strings.Split(rec, "\n")
		f := strings.SplitN(lines[0], "\x1f", 5)
		if len(f) < 5 {
			continue
		}
		secs, _ := strconv.ParseInt(f[2], 10, 64)
		c := gitLogCommit{SHA: f[0], Parents: strings.Fields(f[1]), Time: secs * 1000, Author: f[3], Subject: f[4]}
		for _, l := range lines[1:] {
			if l = strings.TrimSpace(l); l != "" {
				c.Path = l
			}
		}
		commits = append(commits, c)
	}
	return commits
}

// gitStderr is git's own complaint when it exited non-zero, else the error.
func gitStderr(err error) string {
	if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
		return strings.TrimSpace(string(ee.Stderr))
	}
	return err.Error()
}
