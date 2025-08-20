// Simple global event bus implementation
(function(global){
  function EventBus(){ this.handlers = {}; }
  EventBus.prototype.on = function(event, handler){
    (this.handlers[event] || (this.handlers[event] = [])).push(handler);
  };
  EventBus.prototype.emit = function(event, payload){
    (this.handlers[event] || []).forEach(function(h){ h(payload); });
  };
  global.EventBus = EventBus;
})(self);
