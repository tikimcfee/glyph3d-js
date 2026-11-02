package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// gitRepo makes a project root holding a git repo with a file's history:
// v1, v2, a rename (a.txt → b.txt), v3. Skips when git isn't installed.
func gitRepo(t *testing.T) (*FSHandler, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_DATE=2026-01-02T03:04:05Z", "GIT_COMMITTER_DATE=2026-01-02T03:04:05Z")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git("init", "-q")
	git("config", "user.email", "test@example.invalid")
	git("config", "user.name", "Tester")
	git("config", "commit.gpgsign", "false")
	writeFile(t, root, "a.txt", "one\n")
	git("add", "a.txt")
	git("commit", "-q", "-m", "first")
	writeFile(t, root, "a.txt", "one\ntwo\n")
	git("commit", "-q", "-am", "second")
	git("mv", "a.txt", "b.txt")
	git("commit", "-q", "-m", "rename")
	writeFile(t, root, "b.txt", "one\ntwo\nthree\n")
	git("commit", "-q", "-am", "third")
	writeFile(t, root, "loose.txt", "never committed\n")
	h, err := NewFSHandler(root, nil)
	if err != nil {
		t.Fatalf("NewFSHandler: %v", err)
	}
	return h, root
}

func callGitLog(t *testing.T, h *FSHandler, p gitLogParams) (*gitLogResult, *rpcCapture) {
	t.Helper()
	w, c := captureRPC(t)
	h.handleGitLog(w, json.RawMessage(`1`), mustJSON(t, p))
	if c.Error != nil {
		return nil, c
	}
	var r gitLogResult
	if err := json.Unmarshal(c.Result, &r); err != nil {
		t.Fatalf("unmarshal gitLog result: %v", err)
	}
	return &r, c
}

// TestGitLog_FollowsRenamesWithText: newest first, across the rename, each
// revision's name and text as git holds them.
func TestGitLog_FollowsRenamesWithText(t *testing.T) {
	h, root := gitRepo(t)
	r, c := callGitLog(t, h, gitLogParams{URI: "file://" + filepath.Join(root, "b.txt"), N: 10, Text: true})
	if r == nil {
		t.Fatalf("gitLog error: %+v", c.Error)
	}
	if r.Path != "b.txt" {
		t.Errorf("path = %q, want b.txt", r.Path)
	}
	want := []struct{ subject, path, text string }{
		{"third", "b.txt", "one\ntwo\nthree\n"},
		{"rename", "b.txt", "one\ntwo\n"},
		{"second", "a.txt", "one\ntwo\n"},
		{"first", "a.txt", "one\n"},
	}
	if len(r.Commits) != len(want) {
		t.Fatalf("got %d commits, want %d: %+v", len(r.Commits), len(want), r.Commits)
	}
	for i, w := range want {
		got := r.Commits[i]
		if got.Subject != w.subject || got.Path != w.path || got.Text == nil || *got.Text != w.text {
			t.Errorf("commit %d = %q %q %v, want %q %q %q", i, got.Subject, got.Path, got.Text, w.subject, w.path, w.text)
		}
		if len(got.SHA) < 40 || got.Author != "Tester" || got.Time != 1767323045000 {
			t.Errorf("commit %d facts: sha %q author %q time %d", i, got.SHA, got.Author, got.Time)
		}
	}
	if len(r.Commits[3].Parents) != 0 || len(r.Commits[0].Parents) != 1 {
		t.Errorf("parents: first %v, newest %v", r.Commits[3].Parents, r.Commits[0].Parents)
	}
}

// TestGitLog_NCapsAndTextIsOptIn: n limits, and no text unless asked.
func TestGitLog_NCapsAndTextIsOptIn(t *testing.T) {
	h, _ := gitRepo(t)
	r, c := callGitLog(t, h, gitLogParams{URI: "b.txt", N: 2})
	if r == nil {
		t.Fatalf("gitLog error: %+v", c.Error)
	}
	if len(r.Commits) != 2 || r.Commits[0].Subject != "third" || r.Commits[0].Text != nil {
		t.Errorf("n=2 without text: %+v", r.Commits)
	}
	if r, _ := callGitLog(t, h, gitLogParams{URI: "b.txt"}); r == nil || len(r.Commits) != gitLogDefaultN && len(r.Commits) != 4 {
		t.Errorf("default n: %+v", r)
	}
	if _, c := callGitLog(t, h, gitLogParams{URI: "b.txt", N: gitLogMaxN + 1}); c.Error == nil || c.Error.Code != -32602 {
		t.Errorf("n past the max must be refused, got %+v", c.Error)
	}
}

// TestGitLog_TextBudget: past the text cap, later revisions come without text,
// marked — never a partial file.
func TestGitLog_TextBudget(t *testing.T) {
	h, _ := gitRepo(t)
	old := maxGitLogTextBytes
	maxGitLogTextBytes = len("one\ntwo\nthree\n") + len("one\ntwo\n")
	defer func() { maxGitLogTextBytes = old }()
	r, c := callGitLog(t, h, gitLogParams{URI: "b.txt", N: 4, Text: true})
	if r == nil {
		t.Fatalf("gitLog error: %+v", c.Error)
	}
	if r.Commits[0].Text == nil || r.Commits[1].Text == nil {
		t.Errorf("the first two fit the budget: %+v", r.Commits[:2])
	}
	for _, cm := range r.Commits[2:] {
		if cm.Text != nil || !cm.TextOmitted {
			t.Errorf("past the budget a revision is textless + marked: %+v", cm)
		}
	}
}

// TestGitLog_Refusals: an untracked file has no commits; a path outside the
// project, a traversal, or no uri is an error the caller hears.
func TestGitLog_Refusals(t *testing.T) {
	h, _ := gitRepo(t)
	if r, c := callGitLog(t, h, gitLogParams{URI: "loose.txt"}); r == nil || len(r.Commits) != 0 {
		t.Errorf("an untracked file answers with no commits, got %+v %+v", r, c.Error)
	}
	for _, uri := range []string{"", "../outside.txt", "file://" + os.TempDir() + "/elsewhere.txt"} {
		if _, c := callGitLog(t, h, gitLogParams{URI: uri}); c.Error == nil || c.Error.Code != -32602 {
			t.Errorf("uri %q must be refused (invalid params), got %+v", uri, c.Error)
		}
	}
}
