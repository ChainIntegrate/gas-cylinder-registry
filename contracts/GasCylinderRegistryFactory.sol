// SPDX-License-Identifier: LicenseRef-ChainIntegrate-All-Rights-Reserved
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GasCylinderRegistry} from "./GasCylinderRegistry.sol";

/// @title GasCylinderRegistryFactory
/// @notice Creates one `GasCylinderRegistry` per company as an EIP-1167 clone of a single implementation.
/// The factory's owner (ChainIntegrate) decides who gets a registry, but has no rights inside one.
/// The relayer and the app work only with registries for which `isRegistry` is true.
contract GasCylinderRegistryFactory is Ownable {
    /// @notice The registry implementation every clone delegates to.
    address public immutable implementation;

    /// @notice True for every registry this factory created.
    mapping(address => bool) public isRegistry;
    address[] private _registries;

    event RegistryCreated(address indexed registry, address indexed owner, string name, string symbol);

    error InvalidOwner();

    constructor(address initialOwner) {
        implementation = address(new GasCylinderRegistry());
        _transferOwnership(initialOwner);
    }

    /// @notice Creates a registry owned by `registryOwner` (an EOA or a Universal Profile).
    /// @param initialDataKeys ERC725Y data written at creation, typically the wrapped data key slots.
    function createRegistry(
        address registryOwner,
        string calldata name,
        string calldata symbol,
        bytes32[] calldata initialDataKeys,
        bytes[] calldata initialDataValues
    ) external onlyOwner returns (address registry) {
        if (registryOwner == address(0)) revert InvalidOwner();
        registry = Clones.clone(implementation);
        GasCylinderRegistry(payable(registry)).initialize(
            name,
            symbol,
            registryOwner,
            initialDataKeys,
            initialDataValues
        );
        isRegistry[registry] = true;
        _registries.push(registry);
        emit RegistryCreated(registry, registryOwner, name, symbol);
    }

    function registryCount() external view returns (uint256) {
        return _registries.length;
    }

    /// @notice Registries in creation order, `count` from `start`.
    function registries(uint256 start, uint256 count) external view returns (address[] memory list) {
        uint256 total = _registries.length;
        if (start >= total) return new address[](0);
        uint256 end = start + count > total ? total : start + count;
        list = new address[](end - start);
        for (uint256 i = start; i < end; ++i) {
            list[i - start] = _registries[i];
        }
    }
}
