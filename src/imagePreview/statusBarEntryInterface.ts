import * as vscode from 'vscode';

/**
 * Standardized interface for all status bar entries in the TIFF Visualizer extension.
 * This eliminates inconsistencies between different hiding patterns and provides
 * a unified ownership-based approach.
 */
export interface IStatusBarEntry {
	/**
	 * Show the status bar entry with an owner.
	 * @param owner - The object that owns this status bar display
	 * @param args - Additional arguments specific to the entry type
	 */
	show(owner: any, ...args: any[]): void;

	/**
	 * Hide the status bar entry for a specific owner.
	 * Entry will only be hidden if the owner matches the current owner.
	 * @param owner - The object that wants to hide the status bar entry
	 */
	hide(owner: any): void;

	/**
	 * Force hide the status bar entry regardless of ownership.
	 * This should be used sparingly, typically during cleanup or when
	 * switching away from the preview entirely.
	 */
	forceHide(): void;

	/**
	 * Check if the status bar entry is currently visible.
	 */
	isVisible(): boolean;

	/**
	 * Get the current owner of the status bar entry.
	 */
	getCurrentOwner(): any;

	/**
	 * Dispose of the status bar entry and clean up resources.
	 */
	dispose(): void;
}

/**
 * Base implementation of the standardized status bar entry interface.
 * Handles ownership tracking and provides consistent behavior across all entries.
 */
export abstract class BaseStatusBarEntry implements IStatusBarEntry {
	protected readonly entry: vscode.StatusBarItem;
	private _currentOwner: any = undefined;
	private _isVisible: boolean = false;

	constructor(
		id: string,
		name: string,
		alignment: vscode.StatusBarAlignment,
		priority: number
	) {
		this.entry = vscode.window.createStatusBarItem(id, alignment, priority);
		this.entry.name = name;
	}

	public show(owner: any, ...args: any[]): void {
		this._currentOwner = owner;
		this._isVisible = true;
		this.updateDisplay(...args);
		this.entry.show();
	}

	public hide(owner: any): void {
		// Only hide if the requesting owner is the current owner
		if (this._currentOwner === owner) {
			this._isVisible = false;
			this._currentOwner = undefined;
			this.entry.hide();
		}
	}

	public forceHide(): void {
		this._isVisible = false;
		this._currentOwner = undefined;
		this.entry.hide();
	}

	public isVisible(): boolean {
		return this._isVisible;
	}

	public getCurrentOwner(): any {
		return this._currentOwner;
	}

	public dispose(): void {
		this.entry.dispose();
	}

	/**
	 * Abstract method that subclasses must implement to update their display.
	 * Called when show() is invoked with the provided arguments.
	 */
	protected abstract updateDisplay(...args: any[]): void;
}

/**
 * Enhanced base class for status bar entries that need more complex ownership
 * and state management, including integration with the AppStateManager.
 */
export abstract class ManagedStatusBarEntry extends BaseStatusBarEntry {
	private _registeredWithStateManager: boolean = false;

	constructor(
		id: string,
		name: string,
		alignment: vscode.StatusBarAlignment,
		priority: number,
		private readonly entryId: string
	) {
		super(id, name, alignment, priority);
	}

	public show(owner: any, ...args: any[]): void {
		super.show(owner, ...args);
		
		// Register with state manager if available
		if (!this._registeredWithStateManager && this.getStateManager()) {
			this.getStateManager()?.registerStatusBarEntry(this.entryId);
			this._registeredWithStateManager = true;
		}
	}

	public forceHide(): void {
		super.forceHide();
		
		// Unregister from state manager if registered
		if (this._registeredWithStateManager && this.getStateManager()) {
			this.getStateManager()?.unregisterStatusBarEntry(this.entryId);
			this._registeredWithStateManager = false;
		}
	}

	public dispose(): void {
		if (this._registeredWithStateManager && this.getStateManager()) {
			this.getStateManager()?.unregisterStatusBarEntry(this.entryId);
		}
		super.dispose();
	}

	/**
	 * Get the AppStateManager instance. Subclasses should implement this
	 * to provide access to the state manager for coordination.
	 */
	protected abstract getStateManager(): any;
} 