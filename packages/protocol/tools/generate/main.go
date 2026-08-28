package main

import (
	"fmt"
	"os"

	"github.com/the-drunken-coder/atlas/packages/protocol/tools/internal/artifacts"
)

func main() {
	root, err := os.Getwd()
	if err != nil {
		fatal(err)
	}

	if _, err := artifacts.Generate(root, true); err != nil {
		fatal(err)
	}
	fmt.Println("generated Atlas Protocol artifacts")
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
