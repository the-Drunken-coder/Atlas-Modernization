# Problem Report

1. **Time & Date:** 2026-08-30T15:00:42Z
2. **Name:** Resource hardware exercise accepts false-success responses
3. **Issue:** The Resource hardware-exercise matcher treats any valid response from the expected source with the same `request_id` as completion, even when the application status is an error or the body is not the test responder marker required by the exercise contract.
4. **Severity:** S4 (Minor)
5. **Location:** Atlas FieldLink, `packages/fieldlink/src/messages/resource.ts` (`resourceMessage.exercise.isComplete`), `packages/fieldlink/src/cli.ts` (`attachTestRequestResponder`), and `packages/fieldlink/docs/messages/resource.md` (two-radio transport exercise)
6. **Expected:** A `--resource-request` two-radio exercise should complete only after A receives the matching response with the expected successful status and `body.fieldlink_test_responder === true`, as documented. An error response or unrelated valid body should fail or remain incomplete.
7. **Actual:** For a request sent from A, `resourceMessage.exercise.isComplete` checks only source side, response kind, and matching `request_id` at `resource.ts:294-299`. The response `status` and `body` are not checked. The CLI therefore reports a valid `status: 500` response or a `status: 200` response with `fieldlink_test_responder: false` as a passed, correlated exercise.
8. **Reproduction:**
   1. From the repository root, run this source-level matcher probe:

      ```sh
      node --import tsx --input-type=module --eval 'import { resourceMessage } from "./packages/fieldlink/src/messages/resource.ts"; const sent = {type:"resource",kind:"request",operation:"get",request_id:"req-1",resource_type:"task",resource_id:"task-1"}; const cases = [{status:500,body:{error:"failed"}},{status:200,body:{fieldlink_test_responder:false}},{status:200,body:{fieldlink_test_responder:true}}]; const results = cases.map((response) => ({response, valid:resourceMessage.validate({...response,type:"resource",kind:"response",request_id:"req-1"}), complete:resourceMessage.exercise.isComplete({sent,received:{...response,type:"resource",kind:"response",request_id:"req-1"},side:"source"})})); console.log(JSON.stringify(results));'
      ```

   2. Observe that all three responses are valid and `complete: true`, including the error response and the response with the false responder marker:

      ```json
      [
        {
          "response": { "status": 500, "body": { "error": "failed" } },
          "valid": true,
          "complete": true
        },
        {
          "response": {
            "status": 200,
            "body": { "fieldlink_test_responder": false }
          },
          "valid": true,
          "complete": true
        },
        {
          "response": {
            "status": 200,
            "body": { "fieldlink_test_responder": true }
          },
          "valid": true,
          "complete": true
        }
      ]
      ```

   3. The CLI's canned responder happens to emit `status: 200` and `{ fieldlink_test_responder: true }` at `packages/fieldlink/src/cli.ts:487-494`, but the completion path does not enforce those values. The documented exercise requirement is at `packages/fieldlink/docs/messages/resource.md:153-157`.
9. **Notes:** Confirmed at commit `804bf32fa733ca582f931816f58cdb5aae218701` with the focused probe; no hardware was used and no product or test files were changed. Add a matcher regression covering error status, missing marker, false marker, and the expected responder response. Keep the check local to the Resource exercise rather than weakening the general response envelope, which correctly permits application errors.
