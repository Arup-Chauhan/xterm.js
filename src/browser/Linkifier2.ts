/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { ILinkifier2, ILinkProvider, IBufferCellPosition, ILink, ILinkifierEvent, ILinkDecorations } from 'browser/Types';
import { IDisposable } from 'common/Types';
import { IMouseService, IRenderService } from './services/Services';
import { IBufferService } from 'common/services/Services';
import { EventEmitter, IEvent } from 'common/EventEmitter';
import { Disposable, getDisposeArrayDisposable, disposeArray } from 'common/Lifecycle';
import { addDisposableDomListener } from 'browser/Lifecycle';

interface ILinkState {
  decorations: ILinkDecorations;
  isHovered: boolean;
}

interface ILinkWithState {
  link: ILink;
  state?: ILinkState;
}

export class Linkifier2 extends Disposable implements ILinkifier2 {
  private _element: HTMLElement | undefined;
  private _mouseService: IMouseService | undefined;
  private _renderService: IRenderService | undefined;
  private _linkProviders: ILinkProvider[] = [];
  protected _currentLink: ILinkWithState | undefined;
  private _lastMouseEvent: MouseEvent | undefined;
  private _linkCacheDisposables: IDisposable[] = [];
  private _lastBufferCell: IBufferCellPosition | undefined;
  private _isMouseOut: boolean = true;
  private _activeProviderReplies: Map<Number, ILinkWithState[] | undefined> | undefined;
  private _activeLine: number = -1;

  private _onShowLinkUnderline = this.register(new EventEmitter<ILinkifierEvent>());
  public get onShowLinkUnderline(): IEvent<ILinkifierEvent> { return this._onShowLinkUnderline.event; }
  private _onHideLinkUnderline = this.register(new EventEmitter<ILinkifierEvent>());
  public get onHideLinkUnderline(): IEvent<ILinkifierEvent> { return this._onHideLinkUnderline.event; }

  constructor(
    @IBufferService private readonly _bufferService: IBufferService
  ) {
    super();
    this.register(getDisposeArrayDisposable(this._linkCacheDisposables));
  }

  public registerLinkProvider(linkProvider: ILinkProvider): IDisposable {
    this._linkProviders.push(linkProvider);
    return {
      dispose: () => {
        // Remove the link provider from the list
        const providerIndex = this._linkProviders.indexOf(linkProvider);

        if (providerIndex !== -1) {
          this._linkProviders.splice(providerIndex, 1);
        }
      }
    };
  }

  public attachToDom(element: HTMLElement, mouseService: IMouseService, renderService: IRenderService): void {
    this._element = element;
    this._mouseService = mouseService;
    this._renderService = renderService;

    this.register(addDisposableDomListener(this._element, 'mouseleave', () => {
      this._isMouseOut = true;
      this._clearCurrentLink();
    }));
    this.register(addDisposableDomListener(this._element, 'mousemove', this._onMouseMove.bind(this)));
    this.register(addDisposableDomListener(this._element, 'click', this._onClick.bind(this)));
  }

  private _onMouseMove(event: MouseEvent): void {
    this._lastMouseEvent = event;

    if (!this._element || !this._mouseService) {
      return;
    }

    const position = this._positionFromMouseEvent(event, this._element, this._mouseService);
    if (!position) {
      return;
    }
    this._isMouseOut = false;

    // Ignore the event if it's an embedder created hover widget
    const composedPath = event.composedPath() as HTMLElement[];
    for (let i = 0; i < composedPath.length; i++) {
      const target = composedPath[i];
      // Hit Terminal.element, break and continue
      if (target.classList.contains('xterm')) {
        break;
      }
      // It's a hover, don't respect hover event
      if (target.classList.contains('xterm-hover')) {
        return;
      }
    }

    if (!this._lastBufferCell || (position.x !== this._lastBufferCell.x || position.y !== this._lastBufferCell.y)) {
      this._onHover(position);
      this._lastBufferCell = position;
    }
  }

  private _onHover(position: IBufferCellPosition): void {
    // TODO: This currently does not cache link provider results across wrapped lines, activeLine should be something like `activeRange: {startY, endY}`
    // Check if we need to clear the link
    if (this._activeLine !== position.y) {
      this._clearCurrentLink();
      this._askForLink(position, false);
      return;
    }

    // Check the if the link is in the mouse position
    const isCurrentLinkInPosition = this._currentLink && this._linkAtPosition(this._currentLink.link, position);
    if (!isCurrentLinkInPosition) {
      this._clearCurrentLink();
      this._askForLink(position, true);
    }
  }

  private _askForLink(position: IBufferCellPosition, useLineCache: boolean): void {
    if (!this._activeProviderReplies || !useLineCache) {
      this._activeProviderReplies = new Map();
      this._activeLine = position.y;
    }
    let linkProvided = false;

    // There is no link cached, so ask for one
    this._linkProviders.forEach((linkProvider, i) => {
      if (useLineCache) {
        const existingReply = this._activeProviderReplies?.get(i);
        // If there isn't a reply, the provider hasn't responded yet.

        // TODO: If there isn't a reply yet it means that the provider is still resolving. Ensuring
        // provideLinks isn't triggered again saves ILink.hover firing twice though. This probably
        // needs promises to get fixed
        if (existingReply) {
          linkProvided = this._checkLinkProviderResult(i, position, linkProvided);
        }
      } else {
        linkProvider.provideLinks(position.y, (links: ILink[] | undefined) => {
          if (this._isMouseOut) {
            return;
          }
          const linksWithState: ILinkWithState[] | undefined = links?.map(link  => ({ link }));
          this._activeProviderReplies?.set(i, linksWithState);
          linkProvided = this._checkLinkProviderResult(i, position, linkProvided);
        });
      }
    });
  }

  private _checkLinkProviderResult(index: number, position: IBufferCellPosition, linkProvided: boolean): boolean {
    if (!this._activeProviderReplies) {
      return linkProvided;
    }

    const links = this._activeProviderReplies.get(index);

    // Check if every provider before this one has come back undefined
    let hasLinkBefore = false;
    for (let j = 0; j < index; j++) {
      if (!this._activeProviderReplies.has(j) || this._activeProviderReplies.get(j)) {
        hasLinkBefore = true;
      }
    }

    // If all providers with higher priority came back undefined, then this provider's link for
    // the position should be used
    if (!hasLinkBefore && links) {
      const linkAtPosition = links.find(link => this._linkAtPosition(link.link, position));
      if (linkAtPosition) {
        linkProvided = true;
        this._handleNewLink(linkAtPosition);
      }
    }

    // Check if all the providers have responded
    if (this._activeProviderReplies.size === this._linkProviders.length && !linkProvided) {
      // Respect the order of the link providers
      for (let j = 0; j < this._activeProviderReplies.size; j++) {
        const currentLink = this._activeProviderReplies.get(j)?.find(link => this._linkAtPosition(link.link, position));
        if (currentLink) {
          linkProvided = true;
          this._handleNewLink(currentLink);
          break;
        }
      }
    }

    return linkProvided;
  }

  private _onClick(event: MouseEvent): void {
    if (!this._element || !this._mouseService || !this._currentLink) {
      return;
    }

    const position = this._positionFromMouseEvent(event, this._element, this._mouseService);

    if (!position) {
      return;
    }

    if (this._linkAtPosition(this._currentLink.link, position)) {
      this._currentLink.link.activate(event, this._currentLink.link.text);
    }
  }

  private _clearCurrentLink(startRow?: number, endRow?: number): void {
    if (!this._element || !this._currentLink || !this._lastMouseEvent) {
      return;
    }

    // If we have a start and end row, check that the link is within it
    if (!startRow || !endRow || (this._currentLink.link.range.start.y >= startRow && this._currentLink.link.range.end.y <= endRow)) {
      this._linkLeave(this._element, this._currentLink.link, this._lastMouseEvent);
      this._currentLink = undefined;
      disposeArray(this._linkCacheDisposables);
    }
  }

  private _handleNewLink(linkWithState: ILinkWithState): void {
    if (!this._element || !this._lastMouseEvent || !this._mouseService) {
      return;
    }

    const position = this._positionFromMouseEvent(this._lastMouseEvent, this._element, this._mouseService);

    if (!position) {
      return;
    }

    // Trigger hover if the we have a link at the position
    if (this._linkAtPosition(linkWithState.link, position)) {
      this._currentLink = linkWithState;
      this._currentLink.state = {
        decorations: {
          underline: linkWithState.link.decorations === undefined ? true : linkWithState.link.decorations.underline,
          pointerCursor: linkWithState.link.decorations === undefined ? true : linkWithState.link.decorations.pointerCursor
        },
        isHovered: true
      };
      this._linkHover(this._element, linkWithState.link, this._lastMouseEvent);

      // Add listener for tracking decorations changes
      linkWithState.link.decorations = {} as ILinkDecorations;
      Object.defineProperties(linkWithState.link.decorations, {
        pointerCursor: {
          get: () => this._currentLink?.state?.decorations.pointerCursor,
          set: v => {
            if (this._currentLink?.state && this._currentLink.state.decorations.pointerCursor !== v) {
              this._currentLink.state.decorations.pointerCursor = v;
              if (this._currentLink.state.isHovered) {
                this._element?.classList.toggle('xterm-cursor-pointer', v);
              }
            }
          }
        },
        underline: {
          get: () => this._currentLink?.state?.decorations.underline,
          set: v => {
            if (this._currentLink?.state && this._currentLink?.state?.decorations.underline !== v) {
              this._currentLink.state.decorations.underline = v;
              if (this._currentLink.state.isHovered) {
                this._fireUnderlineEvent(linkWithState.link, v);
              }
            }
          }
        }
      });

      // Add listener for rerendering
      if (this._renderService) {
        this._linkCacheDisposables.push(this._renderService.onRenderedBufferChange(e => {
          // When start is 0 a scroll most likely occurred, make sure links above the fold also get
          // cleared.
          const start = e.start === 0 ? 0 : e.start + 1 + this._bufferService.buffer.ydisp;
          this._clearCurrentLink(start, e.end + 1 + this._bufferService.buffer.ydisp);
        }));
      }
    }
  }

  protected _linkHover(element: HTMLElement, link: ILink, event: MouseEvent): void {
    if (this._currentLink?.state) {
      this._currentLink.state.isHovered = true;
      if (this._currentLink.state.decorations.underline) {
        this._fireUnderlineEvent(link, true);
      }
      if (this._currentLink.state.decorations.pointerCursor) {
        element.classList.add('xterm-cursor-pointer');
      }
    }

    if (link.hover) {
      link.hover(event, link.text);
    }
  }

  private _fireUnderlineEvent(link: ILink, showEvent: boolean): void {
    const range = link.range;
    const scrollOffset = this._bufferService.buffer.ydisp;
    const event = this._createLinkUnderlineEvent(range.start.x - 1, range.start.y - scrollOffset - 1, range.end.x, range.end.y - scrollOffset - 1, undefined);
    const emitter = showEvent ? this._onShowLinkUnderline : this._onHideLinkUnderline;
    emitter.fire(event);
  }

  protected _linkLeave(element: HTMLElement, link: ILink, event: MouseEvent): void {
    if (this._currentLink?.state) {
      this._currentLink.state.isHovered = false;
      if (this._currentLink.state.decorations.underline) {
        this._fireUnderlineEvent(link, false);
      }
      if (this._currentLink.state.decorations.pointerCursor) {
        element.classList.remove('xterm-cursor-pointer');
      }
    }

    if (link.leave) {
      link.leave(event, link.text);
    }
  }

  /**
   * Check if the buffer position is within the link
   * @param link
   * @param position
   */
  private _linkAtPosition(link: ILink, position: IBufferCellPosition): boolean {
    const sameLine = link.range.start.y === link.range.end.y;
    const wrappedFromLeft = link.range.start.y < position.y;
    const wrappedToRight = link.range.end.y > position.y;

    // If the start and end have the same y, then the position must be between start and end x
    // If not, then handle each case seperately, depending on which way it wraps
    return ((sameLine && link.range.start.x <= position.x && link.range.end.x >= position.x) ||
      (wrappedFromLeft && link.range.end.x >= position.x) ||
      (wrappedToRight && link.range.start.x <= position.x) ||
      (wrappedFromLeft && wrappedToRight)) &&
      link.range.start.y <= position.y &&
      link.range.end.y >= position.y;
  }

  /**
   * Get the buffer position from a mouse event
   * @param event
   */
  private _positionFromMouseEvent(event: MouseEvent, element: HTMLElement, mouseService: IMouseService): IBufferCellPosition | undefined {
    const coords = mouseService.getCoords(event, element, this._bufferService.cols, this._bufferService.rows);
    if (!coords) {
      return;
    }

    return { x: coords[0], y: coords[1] + this._bufferService.buffer.ydisp };
  }

  private _createLinkUnderlineEvent(x1: number, y1: number, x2: number, y2: number, fg: number | undefined): ILinkifierEvent {
    return { x1, y1, x2, y2, cols: this._bufferService.cols, fg };
  }
}
