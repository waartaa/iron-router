/*****************************************************************************/
/* SubscriptionManager */
/*****************************************************************************/

SubscriptionManager = function () {
  this._subscriptions = {};
  this._routes = {};

  this._routeCache = {};
  this._currentRoute = null;
}

SubscriptionManager.prototype.setDefaultRule = function(rule) {
  this._defaultRule = rule;
};

SubscriptionManager.prototype._subscribe = function(name) {
  var hash = this._hashArgs(arguments);
  var sub = this._subscriptions[hash];
  if(!sub) {
    sub = new SubscriptionManager.Subscription(this, hash, name, arguments);
    this._subscriptions[hash] = sub;
  }

  sub.instances++;
  return sub;
};

SubscriptionManager.prototype.add = function(routeController, args) {
  var route = this._getRoute(routeController);
  var sub = this._subscribe.apply(this, args);

  route.addSubscription(sub.hash);
  return sub;
};

SubscriptionManager.prototype._getRoute = function(routeController) {
  var routeName = routeController.route.name
  var hash = this._hashArgs(routeController.path);
  var route = this._routes[hash];

  if(!route) {
    route = new SubscriptionManager.Route(this, routeName, hash);
    this._routes[hash] = route;
  }
  
  this._applyCache(route, routeController);
  this._applyExpiration(route, routeController);

  if(!this._currentRoute || this._currentRoute !== route) {
    //a newRoute
    this._currentRoute = route;
  }

  return route;
};

SubscriptionManager.prototype._applyCache = function(route, routeController) {
  var cacheCount = this._getRule(routeController, 'cache');
  if(cacheCount < 0) {
    //we don't process this further
    route.caching = false;
  } else if(cacheCount > 0){
    route.caching = true;
    //let do the caching
    this._routeCache[route.name] = this._routeCache[route.name] || [];
    var routeList = this._routeCache[route.name];

    var index = routeList.indexOf(route);
    if(index >= 0) {
      //existing route; add it to the bottom
      routeList.splice(index, 1);
      routeList.push(route);
    } else {
      //new route
      routeList.push(route);
      var excessRouteCount = routeList.length - cacheCount;
      if(excessRouteCount > 0) {
        var removedRoutes = routeList.splice(0, excessRouteCount);
        removedRoutes.forEach(function(r) {
          r.dispose();
        });
      }
    }
  }
};

SubscriptionManager.prototype._applyExpiration = function(route, routeController) {
  var expireIn = this._getRule(routeController, 'expireIn');
  if(expireIn > 0) {
    if(route.caching) {
      var expireInMillis = expireIn * 60 * 1000;
      route.expireIn(expireInMillis);
    } else {
      console.error("IronRouter: cannot set `expireIn` since you've not defined a value for `cache` - (route:", route.name, ")");
    }
  }
};

SubscriptionManager.prototype._getRule = function(routeController, ruleName) {
  var rule = routeController[ruleName];
  if(rule === undefined && routeController.options) {
    rule = routeController.options[ruleName];
  }

  if(rule === undefined) {
    rule = routeController.router.options[ruleName];
  }

  return (rule >=0)? rule: -1;
};

SubscriptionManager.prototype._closeRoute = function(hash) {
  //delete from the main
  var route = this._routes[hash];
  if(route) {
    delete this._routes[hash];
    var index = this._routeCache[route.name].indexOf(route);
    this._routeCache[route.name].splice(index, 1);
  } else {
    console.warn('No route to delete: ', hash);
  }
};

SubscriptionManager.prototype._closeSub = function(hash) {
  var sub = this._subscriptions[hash];
  if(sub) {
    //need to find out whether is this used by other routes
    var noOneIsUsing = true;
    for(var routeHash in this._routes) {
      var route = this._routes[routeHash];
      if(route.existsSubscription(hash)) {
        noOneIsUsing = false;
        break;
      }
    }

    if(noOneIsUsing) {
      //now we can stop the subscriptionHandler
      var usedInCurrentRoute = this._currentRoute && this._currentRoute.existsSubscription(hash);
      if(sub.subscriptionHandler && !usedInCurrentRoute) {
        sub.subscriptionHandler.stop();
      }
      delete this._subscriptions[hash];
    }
  }
};

SubscriptionManager.prototype.run = function() {
  var self = this;
  var readyCallbacks = [];
  var subHashes = {};

  _.each(this._routeCache, function(routeList) {
    _.each(routeList, function(route) {
      _.each(route._subs, function(bool, hash) {
        subHashes[hash] = true;
      });
    });
  });

  //if it is caching, its already there
  if(!this._currentRoute.caching) {
    _.each(this._currentRoute._subs, function(bool, hash) {
      subHashes[hash] = true;
    });
  }

  _.each(subHashes, function(value, hash) {
    var sub = self._subscriptions[hash];
    var handler = SubscriptionManager.insideIronRouter.withValue(false, function() {
      return Meteor.subscribe.apply(Meteor, sub.args);
    });
    sub.setSubscriptionHandler(handler);
    
    //only waiting on subs asked to waitOn explitcily
    if(sub.shouldWait) {
      readyCallbacks.push(handler);
    }
  });

  return {
    ready: function() {
      for(var lc=0; lc < readyCallbacks.length; lc++) {
        if(!readyCallbacks[lc].ready()) {
          return false;
        }
      }

      return true;
    }
  }
};

SubscriptionManager.prototype._hashArgs = function(args) {
  var jsonString = EJSON.stringify(args);
  var md5String = md5(jsonString);
  return md5String;
}

/*****************************************************************************/
/* Env Variables */
/*****************************************************************************/

SubscriptionManager.insideIronRouter = new Meteor.EnvironmentVariable();


/*****************************************************************************/
/* Meteor.subscribe handling */
/*****************************************************************************/

var originalSubscribe = Meteor.subscribe;
Meteor.subscribe = function() {
  var routerInfo = SubscriptionManager.insideIronRouter.get();
  
  if(routerInfo) {
    return routerInfo.router.subscriptions.add(routerInfo.controller, arguments);
  } else {
    return originalSubscribe.apply(Meteor, arguments);
  }
};