package cmd

import (
	"fmt"
	clikitcommand "github.com/kb-labs/clikit/command"
	"sort"
	"strings"

	"github.com/kb-labs/devkit/internal/checks"
	"github.com/spf13/cobra"
)

var statsCmd = &cobra.Command{
	Use:   "stats",
	Short: "Workspace health score and analytics",
	Long: `Shows aggregated health metrics for the workspace:
health score (A–F), breakdown by category, issue type distribution,
coverage metrics, and tech debt summary.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		ws, cfg, err := loadWorkspace()
		if err != nil {
			return err
		}

		registry := checks.Build(cfg, ws.Root, "check")
		results := checks.RunAll(ws, cfg, registry, nil, nil)

		s := computeStats(results)

		if jsonMode {
			if !s.OK {
				return commandFailure("kb-devkit stats")
			}
			return JSONOut(s)
		}

		printStats(s)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(statsCmd)
}

// ─── data model ───────────────────────────────────────────────────────────────

type workspaceStats struct {
	OK           bool                      `json:"ok"`
	Score        int                       `json:"score"`
	Grade        string                    `json:"grade"`
	Summary      statsSummary              `json:"summary"`
	ByCategory   map[string]categoryStats  `json:"by_category"`
	IssuesByType map[string]issueTypeStats `json:"issues_by_type"`
	Coverage     coverageStats             `json:"coverage"`
	TopIssues    []topIssueEntry           `json:"top_issues"`
}

type statsSummary struct {
	Total   int `json:"total"`
	Healthy int `json:"healthy"`
	Warning int `json:"warning"`
	Error   int `json:"error"`
	Errors  int `json:"total_errors"`
	Warns   int `json:"total_warnings"`
}

type categoryStats struct {
	Total   int    `json:"total"`
	Healthy int    `json:"healthy"`
	Issues  int    `json:"issues"`
	Grade   string `json:"grade"`
}

type issueTypeStats struct {
	Check    string `json:"check"`
	Errors   int    `json:"errors"`
	Warnings int    `json:"warnings"`
	Packages int    `json:"packages"` // how many packages have this issue
}

type coverageStats struct {
	WithESLint   pct `json:"with_eslint"`
	WithTSConfig pct `json:"with_tsconfig"`
	WithREADME   pct `json:"with_readme"`
	WithEngines  pct `json:"with_engines"`
	WithExports  pct `json:"with_exports"`
}

type pct struct {
	Pass  int     `json:"pass"`
	Total int     `json:"total"`
	Pct   float64 `json:"pct"`
}

type topIssueEntry struct {
	Check    string `json:"check"`
	Message  string `json:"message"`
	Packages int    `json:"packages"`
}

// ─── computation ─────────────────────────────────────────────────────────────

func computeStats(results map[string]checks.PackageResult) workspaceStats {
	s := workspaceStats{
		ByCategory:   make(map[string]categoryStats),
		IssuesByType: make(map[string]issueTypeStats),
	}

	// Per-message frequency for top issues.
	msgFreq := make(map[string]map[string]int) // check → message → count

	// Coverage trackers (only for ts-lib/ts-app packages).
	eslintTotal, eslintPass := 0, 0
	tscTotal, tscPass := 0, 0
	readmeTotal, readmePass := 0, 0
	enginesTotal, enginesPass := 0, 0
	exportsTotal, exportsPass := 0, 0

	isTS := func(r checks.PackageResult) bool {
		lang := r.Package.Language
		return lang == "typescript" || lang == ""
	}

	for _, r := range results {
		s.Summary.Total++

		state := packageState(r.Issues)
		switch state {
		case "healthy":
			s.Summary.Healthy++
		case "warning":
			s.Summary.Warning++
		case "error":
			s.Summary.Error++
		}

		cat := r.Package.Category
		cs := s.ByCategory[cat]
		cs.Total++
		if state == "healthy" {
			cs.Healthy++
		} else {
			cs.Issues++
		}
		s.ByCategory[cat] = cs

		// Aggregate issues by check type.
		for _, issue := range r.Issues {
			switch issue.Severity {
			case checks.SeverityError:
				s.Summary.Errors++
			case checks.SeverityWarning:
				s.Summary.Warns++
			}

			its := s.IssuesByType[issue.Check]
			its.Check = issue.Check
			if issue.Severity == checks.SeverityError {
				its.Errors++
			} else {
				its.Warnings++
			}
			its.Packages++ // overcounts (once per issue, not per package), corrected below
			s.IssuesByType[issue.Check] = its

			// Track message frequency.
			if msgFreq[issue.Check] == nil {
				msgFreq[issue.Check] = make(map[string]int)
			}
			msgFreq[issue.Check][issue.Message]++
		}

		// Coverage (TS packages only).
		if isTS(r) {
			eslintTotal++
			tscTotal++
			readmeTotal++

			if r.Package.Category == "ts-lib" {
				enginesTotal++
				exportsTotal++
			}

			hasESLint, hasTSC, hasREADME, hasEngines, hasExports := true, true, true, true, true
			for _, issue := range r.Issues {
				switch issue.Check {
				case "eslint":
					hasESLint = false
				case "tsconfig":
					hasTSC = false
				case "structure":
					if strings.Contains(issue.Message, "README.md") {
						hasREADME = false
					}
				case "package_json":
					if strings.Contains(issue.Message, "engines") {
						hasEngines = false
					}
					if strings.Contains(issue.Message, "exports") {
						hasExports = false
					}
				}
			}
			if hasESLint {
				eslintPass++
			}
			if hasTSC {
				tscPass++
			}
			if hasREADME {
				readmePass++
			}
			if r.Package.Category == "ts-lib" {
				if hasEngines {
					enginesPass++
				}
				if hasExports {
					exportsPass++
				}
			}
		}
	}

	// Fix packages count per check (count distinct packages, not issues).
	pkgByCheck := make(map[string]map[string]bool)
	for _, r := range results {
		for _, issue := range r.Issues {
			if pkgByCheck[issue.Check] == nil {
				pkgByCheck[issue.Check] = make(map[string]bool)
			}
			pkgByCheck[issue.Check][r.Package.Name] = true
		}
	}
	for check, its := range s.IssuesByType {
		its.Packages = len(pkgByCheck[check])
		s.IssuesByType[check] = its
	}

	// Grade per category.
	for cat, cs := range s.ByCategory {
		cs.Grade = scoreToGrade(100 * cs.Healthy / max1(cs.Total))
		s.ByCategory[cat] = cs
	}

	// Coverage.
	s.Coverage = coverageStats{
		WithESLint:   makePct(eslintPass, eslintTotal),
		WithTSConfig: makePct(tscPass, tscTotal),
		WithREADME:   makePct(readmePass, readmeTotal),
		WithEngines:  makePct(enginesPass, enginesTotal),
		WithExports:  makePct(exportsPass, exportsTotal),
	}

	// Top issues (by message frequency).
	type msgEntry struct {
		check string
		msg   string
		count int
	}
	var msgs []msgEntry
	for check, freq := range msgFreq {
		for msg, count := range freq {
			msgs = append(msgs, msgEntry{check, msg, count})
		}
	}
	sort.Slice(msgs, func(i, j int) bool { return msgs[i].count > msgs[j].count })
	limit := 5
	if len(msgs) < limit {
		limit = len(msgs)
	}
	for _, m := range msgs[:limit] {
		s.TopIssues = append(s.TopIssues, topIssueEntry{
			Check:    m.check,
			Message:  m.msg,
			Packages: m.count,
		})
	}

	// Overall score: 60% healthy rate + 20% coverage + 20% (1 - error rate).
	healthRate := float64(s.Summary.Healthy) / float64(max1(s.Summary.Total))
	coverageAvg := (s.Coverage.WithESLint.Pct + s.Coverage.WithTSConfig.Pct + s.Coverage.WithREADME.Pct) / 3.0
	errorRate := float64(s.Summary.Error) / float64(max1(s.Summary.Total))

	score := int(60*healthRate + 20*coverageAvg/100 + 20*(1-errorRate))
	s.Score = score
	s.Grade = scoreToGrade(score)
	s.OK = s.Summary.Error == 0

	return s
}

func packageState(issues []checks.Issue) string {
	state := "healthy"
	for _, issue := range issues {
		if issue.Severity == checks.SeverityError {
			return "error"
		} else if issue.Severity == checks.SeverityWarning {
			state = "warning"
		}
	}
	return state
}

func scoreToGrade(score int) string {
	switch {
	case score >= 90:
		return "A"
	case score >= 80:
		return "B"
	case score >= 70:
		return "C"
	case score >= 60:
		return "D"
	default:
		return "F"
	}
}

func makePct(pass, total int) pct {
	if total == 0 {
		return pct{0, 0, 100.0}
	}
	return pct{Pass: pass, Total: total, Pct: 100.0 * float64(pass) / float64(total)}
}

func max1(n int) int {
	if n == 0 {
		return 1
	}
	return n
}

// ─── human output ─────────────────────────────────────────────────────────────

func printStats(s workspaceStats) {
	o := newOutput()

	clikitcommand.Printf("\n%s\n\n", o.label.Render("KB Devkit — Workspace Stats"))

	// Score line.
	gradeStyle := o.healthy
	if s.Score < 60 {
		gradeStyle = o.errStyle
	} else if s.Score < 80 {
		gradeStyle = o.warning
	}
	clikitcommand.Printf("  Health Score   %s  (%s)\n\n",
		gradeStyle.Render(fmt.Sprintf("%d/100  Grade %s", s.Score, s.Grade)),
		fmt.Sprintf("%d healthy, %d warning, %d error of %d total",
			s.Summary.Healthy, s.Summary.Warning, s.Summary.Error, s.Summary.Total),
	)

	// By category.
	clikitcommand.Printf("  %s\n", o.label.Render("By category"))
	var cats []string
	for cat := range s.ByCategory {
		cats = append(cats, cat)
	}
	sort.Strings(cats)
	for _, cat := range cats {
		cs := s.ByCategory[cat]
		bar := gradeBar(cs.Healthy, cs.Total)
		clikitcommand.Printf("  %-14s  %s  %s\n",
			cat,
			bar,
			o.dim.Render(fmt.Sprintf("%d/%d  Grade %s", cs.Healthy, cs.Total, cs.Grade)),
		)
	}
	clikitcommand.Println()

	// Issues by type.
	clikitcommand.Printf("  %s\n", o.label.Render("Issues by check"))
	type checkEntry struct {
		name string
		its  issueTypeStats
	}
	var checkList []checkEntry
	for name, its := range s.IssuesByType {
		checkList = append(checkList, checkEntry{name, its})
	}
	sort.Slice(checkList, func(i, j int) bool {
		return checkList[i].its.Errors+checkList[i].its.Warnings >
			checkList[j].its.Errors+checkList[j].its.Warnings
	})
	for _, ce := range checkList {
		its := ce.its
		clikitcommand.Printf("  %-16s  %s errors  %s warnings  in %s packages\n",
			ce.name,
			errorNum(its.Errors, o),
			warnNum(its.Warnings, o),
			o.dim.Render(fmt.Sprintf("%d", its.Packages)),
		)
	}
	clikitcommand.Println()

	// Coverage.
	clikitcommand.Printf("  %s\n", o.label.Render("Coverage (TS packages)"))
	printCovRow("ESLint config", s.Coverage.WithESLint, o)
	printCovRow("TSConfig     ", s.Coverage.WithTSConfig, o)
	printCovRow("README.md    ", s.Coverage.WithREADME, o)
	printCovRow("engines field", s.Coverage.WithEngines, o)
	printCovRow("exports field", s.Coverage.WithExports, o)
	clikitcommand.Println()

	// Top issues.
	if len(s.TopIssues) > 0 {
		clikitcommand.Printf("  %s\n", o.label.Render("Most common issues"))
		for i, ti := range s.TopIssues {
			clikitcommand.Printf("  %d. [%s] %s  %s\n",
				i+1,
				o.dim.Render(ti.Check),
				ti.Message,
				o.dim.Render(fmt.Sprintf("(%d packages)", ti.Packages)),
			)
		}
		clikitcommand.Println()
	}
}

func printCovRow(label string, p pct, o output) {
	icon := o.StatusIcon("healthy")
	if p.Pct < 50 {
		icon = o.StatusIcon("error")
	} else if p.Pct < 90 {
		icon = o.StatusIcon("warning")
	}
	clikitcommand.Printf("  %s %-14s  %s\n",
		icon, label,
		o.dim.Render(fmt.Sprintf("%.0f%%  (%d/%d)", p.Pct, p.Pass, p.Total)),
	)
}

func gradeBar(pass, total int) string {
	if total == 0 {
		return "────────────"
	}
	filled := 12 * pass / total
	return strings.Repeat("█", filled) + strings.Repeat("░", 12-filled)
}

func errorNum(n int, o output) string {
	if n == 0 {
		return o.dim.Render("0")
	}
	return o.errStyle.Render(fmt.Sprintf("%d", n))
}

func warnNum(n int, o output) string {
	if n == 0 {
		return o.dim.Render("0")
	}
	return o.warning.Render(fmt.Sprintf("%d", n))
}
