# Bringing split settlement into Sovereigncast

nutsplit is a separate service so it can run next to any show, but everything it does maps
onto code Sovereigncast already has. This note says where, for `podcasting_tools` `main` at
`88cbacd1` (2026-11-05). Line numbers refer to that commit.

## What would change

Today `ecash.py` redeems a payment into the instance's Nutshell wallet (`_redeem_and_book`,
line 703) and later melts the whole balance of a mint to one NWC wallet (`_maybe_auto_sweep`,
line 594, through `_melt_balance_to_nwc`, line 461). A "split" sweep mode would sit next to
the existing one:

1. **Book each receipt to the episode's split.** `_redeem_and_book` already knows the
   episode for a nutzap (the `episode` and `ts` context tags read in `nostr_cashu.py:578-580`)
   and matches it by title. After `insert_ecash_receipt`, call `_resolve_v4v_value(v4v, ts,
   amount_sats)` (`community.py:1732`) for the matched episode and write one accrual row per
   recipient. For NUT-18 payments the episode has to come from the request; nutsplit passes
   `?episode=<item guid>&ts=<s>` in the POST URL, next to the existing `?action=stream`.
   Sovereigncast books the gross amount and lets the transfer fee show only in the wallet
   balance (comment above `insert_ecash_receipt`, around line 826); nutsplit does the same by
   default and charges it to the show's own balance, so guests see their exact share.
2. **Store the episode.** `ecash_receipts` (`shared-db-library/db_manager/finance_manager.py:1581`)
   has `token_hash, mint_url, amount_sats, message, sender_name, show_id, transferred_to,
   sender_npub` and no episode. It needs an `episode_guid` column (the title only travels in
   the mirrored invoice row today), and a per-recipient accrual table like nutsplit's
   `entries` (credit, recipient key, msat).
3. **A split sweep instead of one sweep.** Where `_maybe_auto_sweep` compares the mint's
   balance with `ecash_sweep_threshold_sats`, compare each recipient's owed balance with the
   threshold instead. For a Lightning-address recipient: `_lnurl_invoice_for_address`
   (`community.py:1858`) for exactly the owed whole sats, then `service.melt(mint_url,
   invoice)` as `_melt_balance_to_nwc` does. For a keysend recipient: melt to the instance's
   NWC wallet (`make_invoice`, as now) and `pay_keysend` from there, or leave it owed and show
   it, as Hopp does.
4. **Journal before the melt.** Write the payout row before `service.melt`, and settle an
   exception through the melt quote's state (NUT-05) and the inputs' state (NUT-07) instead of
   logging it and trying again with the next receipt. `_maybe_auto_sweep` currently retries on
   the next receipt; for a sweep to one's own wallet that is harmless, for a payment to a guest
   it could pay twice.
5. **Recipient keys.** Key balances by type, address and custom record, so the two
   sub-wallets on node `02d0fd6c…` (customValue 2 and 3, as in E243) stay apart (Hopp M-05).

## Function map

| nutsplit | Sovereigncast |
|---|---|
| `split.ts` `splitRecipients` / `resolveValue` | `community.py:1687` `_split_recipients` / `:1732` `_resolve_v4v_value` (ported; 600 golden vectors from the Python) |
| `split.ts` `isKeysend` / `isLnaddress` | `community.py:1843` `_v4v_is_keysend` / `:1853` `_v4v_is_lnaddress` |
| `lnurl.ts` `lnurlInvoice`, `appendQuery`, `lnurlPayerData` | `community.py:1858` `_lnurl_invoice_for_address`, `:284` `_append_query`, `:1817` `_lnurl_payer_data` |
| `intake.ts` `receivePayment` errors | `ecash.py:703` `_redeem_and_book` and the table in `CASHU_STREAMING.md` |
| `creq.ts` `feedPaymentRequest` | `CASHU_STREAMING.md` Route B, the `<podcast:txt purpose="cashu">` record |
| `settle.ts` `settle` | `ecash.py:594` `_maybe_auto_sweep` + `:461` `_melt_balance_to_nwc`, per recipient |

## One thing found on the way

`_split_recipients` can hand out more than the amount when fee recipients claim more than
100 % between them. Each fee recipient gets `amount * min(split, 100) // 100` before the rest
is computed, and nothing caps their sum:

```python
>>> _split_recipients([r('host', NODE, 100), r('f1', 'a@x', 60, is_fee=True),
...                    r('f2', 'b@x', 60, is_fee=True)], 100)
[{... 'name': 'f1', 'amount_sats': 60}, {... 'name': 'f2', 'amount_sats': 60}]   # 120 of 100
```

Hopp fixed the same case as audit H-02 ("fees claiming 100 % or more together now share the
total by weight"). nutsplit follows Hopp there; with that one exception its output is
identical to Sovereigncast's. A feed would have to declare such fees, so it is a robustness
issue rather than a live one; but `POST /api/community/episode-value-payments` (line 1941)
builds its payment list from these amounts without a sum check, so a 100-sat boost would
become payments of 120 sat in the listener's wallet.
