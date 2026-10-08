# Deploying the public testnet demo

The demo combines a simulated Pix provider with Tempo testnet settlement. The historical pilot is a separate read-only shadow projection of pseudonymized, merchant-attested events. Neither surface is a production payment service.

The repository includes `Dockerfile` and `render.yaml`. Use the current README for the runtime and local setup. Review hosting terms, database retention, capacity and cost before provisioning; no zero-cost or completion-time guarantee is implied. Initial builds and visits after idle periods can take longer.

## 1. Select the source and review the release

Use the intended GitHub repository and exact reviewed commit. Check CI for that same commit. Keep automatic deployment disabled while preparing a freeze; a branch update or passing badge alone is not evidence that a particular commit is deployed.

Do not include local workstation paths, private handoff packages, credentials or merchant data in the public repository. Store service credentials only in the hosting provider's private environment settings.

## 2. Provision PostgreSQL

Provide a PostgreSQL database compatible with the version stated in the README. Choose a region near the application host and review backup and retention settings. Obtain the connection string through the provider's secure interface. Configure it as `DATABASE_URL` in the host's private environment; never put the value in documentation, logs or source control.

## 3. Configure the application host

Connect the reviewed repository to a container-capable host. For a Render Blueprint, review `render.yaml` and the selected branch before applying it. Check the resulting private environment configuration against the Blueprint; do not assume missing values have been generated.

The demo derives testnet wallets from a private host-generated seed. Preserve this seed during service maintenance; do not copy or print it. Confirm testnet funding through the application's diagnostics. Production keys and real-money operation are outside this demo.

For an existing service, confirm automatic deployment is disabled and the exact source commit is approved before an explicitly controlled deployment. Inspect build and startup status. A host status of Live must be followed by application checks; it does not establish functional correctness by itself.

## 4. Verify the deployed behavior

- Confirm the intended deployed commit and passing CI for that commit.
- Open `/demo`; create a fictional order and exercise simulated payment with duplicate webhook delivery. Confirm one settlement attempt and its final state from the timeline.
- Open the receipt and verify the on-chain fields. If the RPC cannot answer conclusively, expect an unavailable result rather than a fabricated success.
- Exercise underpayment, refund and simulated MED cases, checking that unknown outcomes remain blocked for reconciliation.
- Open `/pilot` and confirm read-only shadow mode, scoped aggregate evidence and recorded advisory verdicts. Do not enable live model calls or settlement as a side effect of verification.

Record the source, endpoint, observed result and verification time without secrets. Confirm the applicable release evidence before sharing the endpoint.

## 5. Optional Asaas sandbox configuration

A sandbox adapter is separate from the simulated provider and requires its own validation. Configure only sandbox credentials in the private host environment:

| Variable | Purpose |
| --- | --- |
| `PIX_PROVIDER` | Select the `asaas` adapter only when the sandbox setup is ready |
| `ASAAS_API_KEY` | Receiving sandbox account credential |
| `ASAAS_CUSTOMER_ID` | Sandbox test customer identifier |
| `ASAAS_PAYER_API_KEY` | Optional paying sandbox account credential |
| `ASAAS_WEBHOOK_TOKEN` | Private webhook authentication credential |

Configure the receiving sandbox account's billing-event webhook to `/webhooks/asaas` on the application host with matching private authentication. Review adapter tests and observed sandbox results before describing the adapter as working. Do not use production credentials, real personal data or real money.
