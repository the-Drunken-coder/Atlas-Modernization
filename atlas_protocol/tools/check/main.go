package main

import (
	"fmt"
	"os"

	"github.com/the-drunken-coder/atlas/atlas_protocol/tools/internal/artifacts"
)

func main() {
	root, err := os.Getwd()
	if err != nil {
		fatal(err)
	}

	drift, err := artifacts.Generate(root, false)
	if err != nil {
		fatal(err)
	}
	if len(drift) > 0 {
		fmt.Fprintln(os.Stderr, "generated Atlas Protocol artifacts are stale:")
		for _, path := range drift {
			fmt.Fprintf(os.Stderr, "  %s\n", path)
		}
		fmt.Fprintln(os.Stderr, "run: go run ./tools/generate")
		os.Exit(1)
	}
	fmt.Println("Atlas Protocol examples, Go contracts, and generated artifacts are current")
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
