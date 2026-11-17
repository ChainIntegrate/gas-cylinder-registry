// SPDX-License-Identifier: LicenseRef-ChainIntegrate-All-Rights-Reserved
pragma solidity 0.8.28;

// Test only: LUKSO's Universal Profile (LSP0) and Key Manager (LSP6), compiled so the tests can build a real
// account with an administrator key and an access key, as the ChainIntegrate Account extension does.
import {LSP0ERC725Account} from "@lukso/lsp0-contracts/contracts/LSP0ERC725Account.sol";
import {LSP6KeyManager} from "@lukso/lsp6-contracts/contracts/LSP6KeyManager.sol";
