// Mock for happy-dom to allow tests to run with ESM-only module
export class Window {
  public happyDOM: any;
  public document: any;
  public Buffer: any;
  public Uint8Array: any;
  public addEventListener: any;
  public removeEventListener: any;

  constructor() {
    const listeners: Map<string, Function[]> = new Map();
    
    const addEventListenerFn = jest.fn((event: string, handler: Function) => {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event)!.push(handler);
    });
    
    const removeEventListenerFn = jest.fn((event: string, handler: Function) => {
      const eventListeners = listeners.get(event);
      if (eventListeners) {
        const index = eventListeners.indexOf(handler);
        if (index > -1) {
          eventListeners.splice(index, 1);
        }
      }
    });
    
    const body = {
      children: [] as any[],
      appendChild: jest.fn(function (this: any, el: any) {
        this.children.push(el);
      }),
      get innerHTML() {
        return (this as any).children
          .map((el: any) => {
            const attrs = Object.entries(el.getAttribute ? { id: el.getAttribute('id') } : {})
              .filter(([_, v]) => v)
              .map(([k, v]) => ` ${k}="${v}"`)
              .join('');
            return `<${el.tagName.toLowerCase()}${attrs}></${el.tagName.toLowerCase()}>`;
          })
          .join('');
      },
    };
    
    this.document = {
      addEventListener: addEventListenerFn,
      removeEventListener: removeEventListenerFn,
      createElement: jest.fn((tagName: string) => {
        const attributes: Record<string, string> = {};
        return {
          tagName: tagName.toUpperCase(),
          setAttribute: (name: string, value: string) => {
            attributes[name] = value;
          },
          getAttribute: (name: string) => attributes[name],
          get innerHTML() {
            return '';
          },
        };
      }),
      body,
    };
    
    this.addEventListener = addEventListenerFn;
    this.removeEventListener = removeEventListenerFn;
    
    this.happyDOM = {
      abort: jest.fn(),
    };
  }
}

export const GlobalWindow = undefined;
