# LinkedIn CDP workflow

## Transport

### Every asynchronous operation must reach a known ticket outcome

These JSON blocks show logical MCP calls, not shell commands. Use the actual host's tool interface and prefixes. Angle-bracket values are placeholders to replace with returned references or the user's selected alias; never send them literally. Inspect current tool schemas before use. For accepted calls poll `get_browser_request` with bounded backoff until `succeeded`, `failed` or `uncertain`; on a local deadline inspect the existing ticket, do not resubmit the effect.

```json
{"tool":"request_browser_workspace","arguments":{"required_workspace_count":1,"designated_endpoints":[{"endpoint_nickname":"<selected-profile-alias>"}]}}
```

```json
{"tool":"get_browser_request","arguments":{"request_ref":"<request_ref>"}}
```

On success, read the resolved workspace/tab references from the ticket's returned result. For CDP, unwrap the ticket's command result as advertised by the current tool response. Distinguish the MCP envelope, command reply and `Runtime.evaluate` remote object; never treat an absent `value` as success or ignore `exceptionDetails`.

```json
{"tool":"get_browser_context","arguments":{"view":{"kind":"capabilities","endpoint_nickname":"<selected-profile-alias>","window_ref":null,"method_prefix":null,"page_size":100,"cursor":null}}}
```

Follow any returned pagination cursor. Confirm required Page, Runtime, Input and DOM methods are supported.

```json
{"tool":"send_cdp_command","arguments":{"workspace_ref":"<workspace_ref>","target":{"kind":"tab","tab_ref":"<tab_ref>"},"method":"Page.navigate","params":{"url":"https://www.linkedin.com/feed/?shareActive=true"}}}
```

Use that personal-profile entry only after verifying the selected author. Company-page publishing must start from that page's own composer. A completed navigation ticket does not prove the editor is mounted; query the live DOM with a bounded wait.

## Composer

### Scope every editor lookup to the visible composer

Send the following expression with `Runtime.evaluate` and `returnByValue: true`. This is a probe/focus operation, not a publish action. If the probe throws, inspect the live DOM rather than broadening blindly to an arbitrary page textbox.

```javascript
(() => {
  const visible = e => e.getClientRects().length > 0;
  const dialogs = [...document.querySelectorAll('dialog, [role="dialog"]')].filter(visible);
  const candidates = dialogs.map(dialog => ({dialog, editors: [...dialog.querySelectorAll('[contenteditable="true"]')].filter(visible)}))
    .filter(x => x.editors.length === 1);
  if (candidates.length !== 1) throw new Error('Composer is missing or ambiguous');
  const editor = candidates[0].editors[0];
  editor.focus();
  const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  return {text: editor.innerText, buttons: [...candidates[0].dialog.querySelectorAll('button,[role="button"]')]
    .filter(visible).map(e => ({text: e.innerText, label: e.getAttribute('aria-label'), disabled: e.disabled === true}))};
})()
```

Do not append approved text to unexpected existing text. If populated, stop and compare/ask about replacement. Send the entire approved body separately, as the `text` string in this call; the placeholder is not sample publishable copy:

```json
{"tool":"send_cdp_command","arguments":{"workspace_ref":"<workspace_ref>","target":{"kind":"tab","tab_ref":"<tab_ref>"},"method":"Input.insertText","params":{"text":"<entire-approved-body>"}}}
```

Read back the full editor body and compare normalized whitespace. Count alone cannot detect wrong text. Screenshots establish visual paragraph/media layout. Do not use an automatic length heuristic to shorten approved text.

### Image upload needs a remote object and a return to the composer

Inspect and click the uniquely identified visible photo control through supported Input methods. The photo control can be a div with role=button rather than a button. Once the media dialog exists, obtain its file input as a remote object using `Runtime.evaluate` with **returnByValue: false**; the actual JSON parameter is `"returnByValue": false`. Do not look for an object ID inside a serialized element value.

```javascript
(() => {
  const dialogs = [...document.querySelectorAll('dialog,[role="dialog"]')].filter(e => e.getClientRects().length > 0);
  const inputs = [...new Set(dialogs.flatMap(d => [...d.querySelectorAll('input[type="file"]')]))];
  if (inputs.length !== 1) throw new Error('Reinspect media dialog for the unique file input');
  return inputs[0];
})()
```

If the input is mounted outside the modal, inspect the actual DOM relationship and choose that exact input rather than selecting the first input on the page. Pass its returned `objectId` unchanged:

```json
{"tool":"send_cdp_command","arguments":{"workspace_ref":"<workspace_ref>","target":{"kind":"tab","tab_ref":"<tab_ref>"},"method":"DOM.setFileInputFiles","params":{"objectId":"<live-file-input-objectId>","files":["<absolute-browser-host-image-path>"]}}}
```

Use all approved paths in this single `files` array. Inspect the resulting previews and the uniquely labeled Next control; advance only through the media flow until back in the composer. Recheck attached preview count/order, approved body, author and audience. File-input count alone is insufficient: an upload can still be pending or rejected. Reinspect after rerenders because object IDs and element bounds may become stale.

## Submission

### Identify the submit button without any positional fallback

This JavaScript only inspects enabled publish candidates. **No positional fallback** is permitted. It intentionally does not click anything; approval and the live composer checks must occur before a separate input action. Resolve actual accessible names from live DOM/accessibility output; the examples below are exact known labels, not a universal LinkedIn selector.

```javascript
(() => {
  const visible = e => e.getClientRects().length > 0;
  const dialogs = [...document.querySelectorAll('dialog,[role="dialog"]')].filter(visible);
  const labels = new Set(['Post', '发布', '动态']);
  const buttons = [...new Set(dialogs.flatMap(d => [...d.querySelectorAll('button,[role="button"]')]))];
  const found = buttons.filter(e => visible(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true'
    && (labels.has((e.innerText || '').trim()) || labels.has((e.getAttribute('aria-label') || '').trim())));
  if (found.length !== 1) throw new Error('No unique publish control; remain unsent');
  const e = found[0], r = e.getBoundingClientRect();
  return {text: e.innerText, label: e.getAttribute('aria-label'), x: r.x + r.width / 2, y: r.y + r.height / 2};
})()
```

Ensure this is the composer, not an image editor. After current approval, use supported `Input.dispatchMouseEvent` at the freshly verified control, move/press/release as required, then wait for tickets and visible state. Do not evaluate the probe again and click on a different layout without reinspection. Do not submit multiple times when the modal remains open.

## Evidence

### Match a live post rather than an unrelated activity link

Save a small attempt receipt before submission (approved text/media references, author, audience, workspace, tab, timestamp and `pending`). After submitting save the request reference/outcome where returned, without secrets. If a connection fails before a ticket is obtained, mark the local attempt uncertain too: absence of a ticket is not proof that the click never happened.

After success, take the toast's View post permalink or locate the approved hook in the selected identity's activity list, expand its card and inspect ancestors for its own activity link/data-urn. Verify the full body, author and media before choosing an activity ID. Do not use the page's first analytics link. Open the exact `https://www.linkedin.com/feed/update/urn:li:activity:<id>/` URL and compare the full body after expanding See more.

Receipt statuses should distinguish `prepared_unsent`, `published_verified`, `published_mismatch`, `uncertain` and `failed_before_submit`. Record actual observation time separately from platform publication time; if LinkedIn only says “N minutes ago”, do not invent an exact publication minute. Store screenshot paths and verification results through the host's normal file tools.

## Cleanup

### End the owned workspace without closing a shared browser

```json
{"tool":"terminate_workspace","arguments":{"workspace_ref":"<workspace_ref>"}}
```

Poll the returned ticket to completion. Do not terminate a prepared composer handed to the human or silently discard unsaved content. For uncertain effects, read the ticket and context first and follow the broker's explicit resolution schema; never invent a resolution answer or force success simply to clean up. Retain a concise handoff with references if blocked. Never stop the shared Broker or other sessions' tabs.
