# Test Tasks for E2E Testing

## Test Milestone

Simple tasks to verify the loop orchestration works correctly.

- [ ] `test-01` Create a file called `test-file-1.txt` with content "Task 1 complete"
- [ ] `test-02` Create a file called `test-file-2.txt` with content "Task 2 complete"
  - depends: test-01
- [ ] `test-03` Create a file called `test-summary.txt` listing both files created
  - depends: test-02
